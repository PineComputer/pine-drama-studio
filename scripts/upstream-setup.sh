#!/usr/bin/env bash
# Prepare the Code-OSS checkout for a new developer:
# clone microsoft/vscode next to this repository (or VSCODE_DIR), create the branch named in
# upstream/vscode.lock at its base commit, and apply our patch series. Compiling is left to the
# developer (it takes a while); the commands are printed at the end.
# Safe to re-run: an existing branch is left alone and only checked.
set -euo pipefail
STUDIO="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE_DIR="${VSCODE_DIR:-$STUDIO/../vscode}"
lock() { grep -E "^$1=" "$STUDIO/upstream/vscode.lock" | cut -d= -f2-; }
REPO="$(lock repository)"; BASE="$(lock base)"; BRANCH="$(lock branch)"

if [ ! -d "$VSCODE_DIR/.git" ]; then
	echo "cloning $REPO into $VSCODE_DIR (large: about 2 GB of history)"
	git clone "$REPO" "$VSCODE_DIR"
fi
VSCODE_DIR="$(cd "$VSCODE_DIR" && pwd)"
git -C "$VSCODE_DIR" cat-file -e "$BASE^{commit}" 2>/dev/null || git -C "$VSCODE_DIR" fetch origin "$BASE"

if git -C "$VSCODE_DIR" rev-parse --verify -q "$BRANCH" >/dev/null; then
	echo "branch $BRANCH exists; leaving it as it is"
	git -C "$VSCODE_DIR" merge-base --is-ancestor "$BASE" "$BRANCH" || echo "warning: $BRANCH does not contain base $BASE" >&2
else
	if [ -n "$(git -C "$VSCODE_DIR" status --porcelain --untracked-files=no)" ]; then
		echo "$VSCODE_DIR has uncommitted changes; commit or stash them first" >&2
		exit 1
	fi
	git -C "$VSCODE_DIR" switch -c "$BRANCH" "$BASE"
	shopt -s nullglob
	patches=("$STUDIO"/upstream/patches/*.patch)
	if [ ${#patches[@]} -gt 0 ]; then
		git -C "$VSCODE_DIR" am --3way "${patches[@]}"
	fi
	echo "created $BRANCH at ${BASE:0:11} with ${#patches[@]} patch(es)"
fi

cat <<EOF

Next, compile Code-OSS once (Node from $VSCODE_DIR/.nvmrc):
  cd "$VSCODE_DIR" && npm install && npm run electron && npm run compile
Then run the Studio:
  cd "$STUDIO" && scripts/dev-launch.sh --disable-extension GitHub.copilot-chat
EOF
