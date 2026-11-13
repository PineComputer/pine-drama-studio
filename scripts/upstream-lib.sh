# Shared by the upstream-* scripts. Sourced, not run.
STUDIO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="${VSCODE_DIR:-$(cd "$STUDIO/../vscode" && pwd)}"
LOCK="$STUDIO/upstream/vscode.lock"
PATCH_DIR="${PATCH_DIR:-$STUDIO/upstream/patches}"
TOUCHPOINT_BUDGET=10

lock_value() {
	local v
	v=$(grep -E "^$1=" "$LOCK" | cut -d= -f2-)
	[ -n "$v" ] || { echo "upstream/vscode.lock has no '$1'" >&2; exit 1; }
	printf '%s' "$v"
}
BASE="$(lock_value base)"
BRANCH="${PINE_BRANCH:-$(lock_value branch)}"

# Layer 3: upstream files the series modifies or deletes, as opposed to files it adds.
touchpoints() {
	git -C "$VSCODE_DIR" diff --name-only --diff-filter=MDR "$BASE" "$1"
}
