#!/usr/bin/env bash
# Launch Pine Drama Studio in development mode on a compiled Code-OSS checkout.
# Changes no tracked upstream file: product.overrides.json is ignored by upstream's .gitignore,
# and the extension loads from this repository through --extensionDevelopmentPath.
# Usage: scripts/dev-launch.sh [folder-to-open]   (VSCODE_DIR defaults to ../vscode)
set -euo pipefail
STUDIO="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE_DIR="${VSCODE_DIR:-$(cd "$STUDIO/../vscode" && pwd)}"
EXT="$STUDIO/extensions/pine-drama"
DEV="$STUDIO/.dev"

if ! git -C "$VSCODE_DIR" check-ignore -q product.overrides.json; then
	echo "product.overrides.json is not ignored in $VSCODE_DIR; refusing to write it" >&2
	exit 1
fi
# The dev Studio must carry the same Code-OSS changes as the package (upstream/patches), every one of them: without them
# it offers upstream's Copilot chat, and without the later
# ones the extension calls workbench commands that do not exist. Checked by patch id, not by a symbol of one patch.
VSCODE_DIR="$VSCODE_DIR" "$STUDIO/scripts/upstream-carries.sh"
cp "$STUDIO/upstream/product.overrides.dev.json" "$VSCODE_DIR/product.overrides.json"

(cd "$EXT" && npm run --silent compile)
mkdir -p "$DEV/user-data" "$DEV/extensions"

# The Pine environment to use (one endpoint and pk_ key). Only the path is passed;
# the extension reads the file. Override with PINE_DRAMA_ENV_FILE.
export PINE_DRAMA_ENV_FILE="${PINE_DRAMA_ENV_FILE:-$STUDIO/.env}"
[ -f "$PINE_DRAMA_ENV_FILE" ] || echo "note: $PINE_DRAMA_ENV_FILE does not exist; the Studio will say no Pine environment is set up" >&2

# Built-in extensions outside upstream/builtin-extensions.allow are disabled, as packaging will leave them out.
ALLOW="$STUDIO/upstream/builtin-extensions.allow"
DISABLE=()
while read -r id; do
	grep -qxF "$id" "$ALLOW" || DISABLE+=(--disable-extension "$id")
done < <(cd "$VSCODE_DIR" && for f in extensions/*/package.json .build/builtInExtensions/*/package.json; do
	[ -f "$f" ] && node -e 'const p=require(require("path").resolve(process.argv[1])); console.log(`${p.publisher}.${p.name}`)' "$f"
done)

# Workspace trust guards against running a code project's tasks and settings; the Studio runs nothing
# from a drama project, so its Restricted Mode only gets in the way.
# Code-OSS is already compiled; skip preLaunch so nothing in the checkout is rebuilt or downloaded.
export VSCODE_SKIP_PRELAUNCH=1
exec "$VSCODE_DIR/scripts/code.sh" \
	--user-data-dir "$DEV/user-data" \
	--extensions-dir "$DEV/extensions" \
	--extensionDevelopmentPath "$EXT" \
	--disable-workspace-trust \
	"${DISABLE[@]}" \
	"$@"
