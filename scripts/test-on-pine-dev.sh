#!/usr/bin/env bash
# Run the Studio's test suites on the pine-dev host instead of this Mac.
#
#   scripts/test-on-pine-dev.sh studio <ref> [--minutes N] [--wait N]
#
# The host has no GitHub credential and gets none: the code goes up as a git bundle made here, incremental against the
# commits the host already holds. The host's side is
# scripts/pine-dev-test-remote.sh, copied up with the bundle and run there.
#
#   <ref>        any commit-ish of the repository (a branch, a tag, a sha, origin/main)
#   --minutes N  the run's total limit on the host (default 45)
#   --wait N     how long to wait for a free slot (default 30): up to 8 runs at a time on the host
#
# Environment: PINE_DEV_HOST (default pine-dev);
# PINE_DEV_STATE, only to check a change to the runner itself: its slots and version in ~/test-runs/<name>, not the host's.
# Exit code: 0 all suites passed, 1 a suite failed, 3 the host stayed busy for --wait minutes, 4 the limit ran out,
# 6 this checkout's runner is older than one the host has run (rebase onto main).
# The run on the host lasts only while this script does: it sends a heartbeat, and the host stops the run when it stops.
# Reads and writes nothing in the repositories but one temporary ref, refs/pine-dev-test/<sha>, removed on exit.
set -euo pipefail

STUDIO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${PINE_DEV_HOST:-pine-dev}"
MINUTES=45
WAIT=30

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
[ $# -ge 2 ] || usage
WHICH="$1"; REF="$2"; shift 2
while [ $# -gt 0 ]; do
	case "$1" in
		--minutes) MINUTES="${2:?--minutes needs a number}"; shift 2 ;;
		--wait) WAIT="${2:?--wait needs a number}"; shift 2 ;;
		*) usage ;;
	esac
done
case "$WHICH" in
	studio) REPO="$STUDIO" ;;
	*) usage ;;
esac
[ -n "$REPO" ] && git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "no git checkout for $WHICH" >&2; exit 2; }

# One SSH connection for the whole run (a poll that opened a new one each time once filled the host's MaxStartups).
# The control socket lives in a short path: a unix socket path is limited to about 100 bytes on macOS.
WORK="$(mktemp -d /tmp/ptd.XXXXXX)"
CTL="$WORK/c"
SSH_OPTS=(-o BatchMode=yes -o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=15m -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
TEMP_REFS=()
RUN_PIDS=()
cleanup() {
	local ref
	# The heartbeat first: its end closes the run's stdin, and the host stops the run.
	kill ${RUN_PIDS[@]+"${RUN_PIDS[@]}"} 2>/dev/null || true
	for ref in ${TEMP_REFS[@]+"${TEMP_REFS[@]}"}; do git -C "${ref%%|*}" update-ref -d "${ref#*|}" 2>/dev/null || true; done
	ssh "${SSH_OPTS[@]}" -O exit "$HOST" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
rs() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

# ship <repo name> <checkout> <sha> [tag names]: make sure the host's bare repository holds <sha> (as refs/runs/<sha>) and the
# tags, as lightweight tags on the commits they name here. Only objects the host lacks travel: the bundle leaves out the
# history of commits the host already holds.
ship() {
	local name="$1" dir="$2" sha="$3"; shift 3
	local tags=("$@") t s ex=() tagpairs="" refs=("refs/pine-dev-test/$sha")
	local repo="~/test-runs/$name/repo.git"
	rs "mkdir -p ~/test-runs/$name && { [ -d $repo ] || git init -q --bare $repo; }; git -C $repo for-each-ref --format='%(objectname)' refs/runs" > "$WORK/have.$name"
	for t in ${tags[@]+"${tags[@]}"}; do tagpairs="$tagpairs $t=$(git -C "$dir" rev-parse --verify "refs/tags/$t^{commit}")"; done
	# Is everything already there? (A commit the host holds as an ancestor of another run counts.)
	local want="$sha" pair
	for pair in $tagpairs; do want="$want ${pair#*=}"; done
	local present
	present="$(rs "for c in $want; do git -C $repo cat-file -e \$c^{commit} 2>/dev/null || echo missing; done" || true)"
	if [ -z "$present" ]; then
		rs "git -C $repo update-ref refs/runs/$sha $sha$(for pair in $tagpairs; do printf '; git -C %s update-ref refs/tags/%s %s' "$repo" "${pair%%=*}" "${pair#*=}"; done)"
		echo "[$name] ${sha:0:12} already on $HOST"
		return 0
	fi
	if [ "$(git -C "$dir" rev-parse --is-shallow-repository)" = true ]; then
		echo "$dir is a shallow clone, which cannot be bundled: run  git -C $dir fetch --unshallow origin  once" >&2; exit 2
	fi
	# Commits the host holds and this checkout knows: the bundle leaves their history out. The newest few are enough.
	while read -r s; do
		[ -n "$s" ] && git -C "$dir" cat-file -e "$s^{commit}" 2>/dev/null && ex+=("^$s")
	done < <(tail -n 8 "$WORK/have.$name")
	git -C "$dir" update-ref "refs/pine-dev-test/$sha" "$sha"; TEMP_REFS+=("$dir|refs/pine-dev-test/$sha")
	for pair in $tagpairs; do
		git -C "$dir" update-ref "refs/pine-dev-test/tag-${pair%%=*}" "${pair#*=}"; TEMP_REFS+=("$dir|refs/pine-dev-test/tag-${pair%%=*}")
		refs+=("refs/pine-dev-test/tag-${pair%%=*}")
	done
	git -C "$dir" bundle create -q "$WORK/$name.bundle" "${refs[@]}" ${ex[@]+"${ex[@]}"} \
		|| { echo "[$name] could not bundle $sha" >&2; exit 2; }
	echo "[$name] bundle $(du -h "$WORK/$name.bundle" | cut -f1) (${#ex[@]} known commit(s) left out)"
	scp "${SSH_OPTS[@]}" -q "$WORK/$name.bundle" "$HOST:/tmp/ptd-$name-$$.bundle"
	# Whatever refs the bundle holds are taken; a ref it left out names a commit the host already holds.
	rs "git -C $repo fetch -q /tmp/ptd-$name-$$.bundle 'refs/pine-dev-test/*:refs/pine-dev-test/*' 2>/dev/null; rm -f /tmp/ptd-$name-$$.bundle; git -C $repo update-ref refs/runs/$sha $sha$(for pair in $tagpairs; do printf '; git -C %s update-ref refs/tags/%s %s' "$repo" "${pair%%=*}" "${pair#*=}"; done)" \
		|| { echo "[$name] the host could not take the bundle" >&2; exit 2; }
}

SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
ID="$(date -u +%Y%m%dT%H%M%S)-${SHA:0:8}"
echo "[$WHICH] $REF = ${SHA:0:12}; run $ID on $HOST"

ship studio "$REPO" "$SHA"

# Staged outside the run's folder, which the host makes only once this run holds a slot.
rs "mkdir -p ~/test-runs/staging/$ID"
scp "${SSH_OPTS[@]}" -q "$STUDIO/scripts/pine-dev-test-remote.sh" "$STUDIO/scripts/pine-dev-lock.sh" "$HOST:test-runs/staging/$ID/"
echo "[$WHICH] running; the full log: $HOST:~/test-runs/$WHICH/$ID/run.log"
# The heartbeat: a line every 20 s on the run's stdin while this shell lives (scripts/pine-dev-lock.sh, ptd_supervise); only
# it holds the pipe's write end (its sleep does not). ssh runs in the background, as itself rather than in a subshell, so
# that INT or TERM interrupts the `wait` at once (a foreground command defers the trap until it ends) and the cleanup
# ends both.
mkfifo "$WORK/beat"
set +e
( while kill -0 $$ 2>/dev/null; do echo; sleep 20 > /dev/null; done ) > "$WORK/beat" &
RUN_PIDS+=("$!")
ssh "${SSH_OPTS[@]}" "$HOST" "${PINE_DEV_STATE:+PTD_STATE=$PINE_DEV_STATE }bash ~/test-runs/staging/$ID/pine-dev-test-remote.sh $WHICH $SHA $ID $MINUTES $WAIT none" \
	< "$WORK/beat" &
RUN_PIDS+=("$!")
wait "${RUN_PIDS[1]}"
code=$?
set -e
echo "[$WHICH] exit $code (0 passed, 1 failed, 3 host busy, 4 time limit, 6 runner older than the host's)"
exit "$code"
