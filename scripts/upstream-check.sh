#!/usr/bin/env bash
# Apply the patch series to a clean checkout of the base commit, in a temporary worktree,
# and report the touchpoints. Proves the series alone rebuilds our tree.
set -euo pipefail
source "$(dirname "$0")/upstream-lib.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pine-upstream-check.XXXXXX")"
cleanup() { git -C "$VSCODE_DIR" worktree remove --force "$TMP/tree" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

git -C "$VSCODE_DIR" worktree add --quiet --detach "$TMP/tree" "$BASE"
shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
	git -C "$TMP/tree" -c user.name=check -c user.email=check@localhost am --quiet --3way "${patches[@]}" \
		|| { echo "FAIL: the series does not apply to $BASE" >&2; exit 1; }
fi

tp=$(git -C "$TMP/tree" diff --name-only --diff-filter=MDR "$BASE" HEAD | grep -c . || true)
echo "OK: ${#patches[@]} patch(es) apply to ${BASE:0:11}; touchpoints: $tp/$TOUCHPOINT_BUDGET"
if [ "$tp" -gt "$TOUCHPOINT_BUDGET" ]; then
	echo "OVER BUDGET: more than $TOUCHPOINT_BUDGET touchpoints is a decision for the maintainers" >&2
	exit 2
fi
