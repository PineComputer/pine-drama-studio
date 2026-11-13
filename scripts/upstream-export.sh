#!/usr/bin/env bash
# Export the commits of the Code-OSS branch (upstream/vscode.lock) as the patch series in
# upstream/patches/, one patch per commit. The series is the source of truth.
set -euo pipefail
source "$(dirname "$0")/upstream-lib.sh"

git -C "$VSCODE_DIR" rev-parse --verify -q "$BRANCH" >/dev/null || { echo "no branch $BRANCH in $VSCODE_DIR" >&2; exit 1; }
git -C "$VSCODE_DIR" merge-base --is-ancestor "$BASE" "$BRANCH" || { echo "$BRANCH does not contain base $BASE; rebase it first" >&2; exit 1; }
if [ -n "$(git -C "$VSCODE_DIR" status --porcelain --untracked-files=no)" ] && [ "$(git -C "$VSCODE_DIR" branch --show-current)" = "$BRANCH" ]; then
	echo "warning: uncommitted changes in $VSCODE_DIR are not exported" >&2
fi

mkdir -p "$PATCH_DIR"
find "$PATCH_DIR" -name '*.patch' -delete
# Stable output: no commit ids or version signature, so an unchanged commit exports byte-identical.
git -C "$VSCODE_DIR" format-patch --quiet --zero-commit --no-signature --no-stat -o "$PATCH_DIR" "$BASE..$BRANCH"

count=$(find "$PATCH_DIR" -name '*.patch' | wc -l | tr -d ' ')
tp=$(touchpoints "$BRANCH" | grep -c . || true)
echo "exported $count patch(es) from $BRANCH to ${PATCH_DIR#$STUDIO/}; touchpoints: $tp/$TOUCHPOINT_BUDGET"
touchpoints "$BRANCH" | sed 's/^/  touchpoint: /'
