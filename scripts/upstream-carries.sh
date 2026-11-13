#!/usr/bin/env bash
# Whether the Code-OSS checkout (VSCODE_DIR) carries the exported patch series (upstream/patches), in order, on top of
# the base in upstream/vscode.lock. A change is matched by its patch id, git's identity of a diff whatever its commit
# (git-patch-id; `git cherry` matches commits the same way), so a rebuilt or rebased branch still matches. Commits after
# the series (work not exported yet) and uncommitted edits are allowed. dev-launch.sh runs it before every launch.
set -euo pipefail
source "$(dirname "$0")/upstream-lib.sh"

head=$(git -C "$VSCODE_DIR" rev-parse --abbrev-ref HEAD)
if ! git -C "$VSCODE_DIR" merge-base --is-ancestor "$BASE" HEAD; then
	echo "$VSCODE_DIR ($head) does not contain the base $BASE that upstream/vscode.lock names. Check out $BRANCH and recompile." >&2
	exit 1
fi

# The checkout's changes since the base, oldest first, one patch id per commit.
actual=$(git -C "$VSCODE_DIR" log --reverse -p "$BASE..HEAD" | git patch-id --stable | cut -d' ' -f1)
i=0
for patch in "$PATCH_DIR"/*.patch; do
	[ -e "$patch" ] || continue
	i=$((i + 1))
	want=$(git patch-id --stable < "$patch" | cut -d' ' -f1)
	have=$(printf '%s\n' "$actual" | sed -n "${i}p")
	if [ "$want" != "$have" ]; then
		echo "$VSCODE_DIR ($head) does not carry the Pine patch series: $(basename "$patch") is not its change number $i since the base. Check out $BRANCH, the branch upstream/vscode.lock names, and recompile." >&2
		exit 1
	fi
done
echo "$VSCODE_DIR ($head) carries the $i patch(es) of upstream/patches"
