#!/usr/bin/env bash
# The pine-dev side of scripts/test-on-pine-dev.sh: staged in ~/test-runs/staging/<run id>/ and run there. Not meant
# to be run by hand (doc/development.md, "Tests on pine-dev").
#
#   remote.sh studio <sha> <run id> <minutes> <wait minutes> none
#
# Up to 8 runs at a time (slots, supervision and the runner version gate are scripts/pine-dev-lock.sh; a caller that finds
# all slots taken says it waits, and gives up after <wait minutes>), the whole run under `timeout` and stopped when its
# caller goes away, everything installed under ~/test-runs (no root, no credential), caches keyed by the file that
# decides them. stdout is the summary; the full log is <run dir>/run.log.
# Exit: 0 passed, 1 failed, 3 host busy, 4 time limit, 5 the caller went away, 6 this runner is older than the host's.
set -uo pipefail

WHICH="$1"; SHA="$2"; ID="$3"; MINUTES="$4"; WAIT="$5"
ROOT="$HOME/test-runs"
# Where the slots, holders and runner version live: the host's, unless a check of a runner change names its own
# (PINE_DEV_STATE in test-on-pine-dev.sh), so that a runner not yet on main never switches the shared host.
STATE="$ROOT/${PTD_STATE:-.}"
RUN="$ROOT/$WHICH/$ID"
TOOLS="$ROOT/tools"
CACHE="$ROOT/cache"
LOG="$RUN/run.log"
NODE_VERSION=24.22.1   # Code-OSS's .nvmrc; CI uses the 24 line
PLAYWRIGHT_VERSION=1.64.1   # the render smoke test's headless Chromium (build 1248); not a dependency of the extension

source "$(dirname "$0")/pine-dev-lock.sh"
if [ "${PTD_INNER:-}" != 1 ]; then
	# Up to 8 runs at once, any mix of repositories. This file and the lock library were staged in ~/test-runs/staging/<id>.
	ptd_gate "$STATE" || { rm -rf "$(dirname "$0")"; exit 6; }
	t_start=$(date +%s)
	ptd_watch_wait   # the caller's heartbeat is read while this run waits, too (pine-dev-lock.sh)
	# A caller gone while this run waits ends it by TERM (ptd_watch_wait): it leaves no staging folder behind (worker-07).
	trap 'rm -rf "$(dirname "$0")"' EXIT; trap 'exit 143' TERM
	ptd_acquire "$STATE" "$((WAIT * 60))" "$WHICH" "$ID" || { ptd_unwatch_wait; echo "still busy after $WAIT min; nothing was run"; rm -rf "$(dirname "$0")"; exit 3; }
	ptd_cores "$STATE" "$SLOT" "$(( WAIT * 60 - ($(date +%s) - t_start) ))" \
		|| { ptd_unwatch_wait; echo "no core came free within $WAIT min; nothing was run"; ptd_release "$STATE" "$SLOT"; rm -rf "$(dirname "$0")"; exit 3; }
	ptd_unwatch_wait; trap - TERM
	t_slot=$(date +%s)
	trap 'ptd_finish "$RUN"; ptd_release "$STATE" "$SLOT"; rm -rf "$(dirname "$0")"; echo "[slot $SLOT released $(( $(date +%s) - t_start ))s after the start: waited $(( t_slot - t_start ))s for it, held it $(( $(date +%s) - t_slot ))s]"' EXIT
	mkdir -p "$RUN"
	echo "[slot $SLOT of 8; $(ptd_holders "$STATE" | wc -l) run(s) active; $SHARE of the $PTD_CORES cores]"
	# The run is a child under `timeout`, which signals its whole process group; the lock stays with this shell.
	ptd_supervise env PTD_INNER=1 PTD_SHARE="$SHARE" timeout -k 30 "${MINUTES}m" bash "$0" "$@"
	code=$?
	[ "$code" = 124 ] && { echo "time limit of $MINUTES min reached; the run was stopped (log: $LOG)"; code=4; }
	# Only to the log: the caller's connection is gone, and a write to it would end this shell before its trap.
	[ "$code" = 5 ] && echo "the caller went away (no heartbeat for $PTD_BEAT s, or its connection closed); the run was stopped" >> "$LOG"
	exit "$code"
fi

t0=$(date +%s)
# This run's test processes: the cores its slot holder claimed (ptd_cores), so all runs together stay within the host's.
ACTIVE="$(ptd_holders "$STATE" | wc -l)"
PAR="$PTD_SHARE"
# Peak memory of this run: the sum of its process group's resident sets, sampled on the host every 2 s.
PGID="$(ps -o pgid= -p $$ | tr -d ' ')"
( peak=0; while :; do now="$(ps -eo pgid=,rss= 2>/dev/null | awk -v g="$PGID" '$1==g {s+=$2} END {print s+0}')"; [ "$now" -gt "$peak" ] && { peak="$now"; echo "$peak" > "$RUN/peak-rss-kb"; }; sleep 2; done ) &
SAMPLER=$!
trap 'kill "$SAMPLER" 2>/dev/null' EXIT
say() { echo "$*" | tee -a "$LOG"; }
phase() { say "[$(( $(date +%s) - t0 ))s] $*"; }
# Everything a step prints goes to the log; the summary says what mattered.
quiet() { "$@" >> "$LOG" 2>&1; }
# The failing tests of a unittest log, once each (a subtest's parameters dropped), at most 15 lines; the log has all of them.
failing() {
	local names
	names="$(grep -E '^(FAIL|ERROR):' "$1" | sed -E 's/^(FAIL|ERROR): ([^ ]+ \([^)]*\)).*/\1: \2/' | sort -u)"
	[ -z "$names" ] && return 0
	echo "$names" | head -15 | sed 's/^/    /' | tee -a "$LOG"
	[ "$(echo "$names" | wc -l)" -gt 15 ] && say "    ... and $(( $(echo "$names" | wc -l) - 15 )) more distinct tests (see $LOG)"
	return 0
}

# An ssh session starts at 1024 open files, and a test that opens a connection per case needs more (CI runners allow much more).
ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
mkdir -p "$TOOLS" "$CACHE" "$RUN"
: > "$LOG"
# Keep the last 3 of each cache, so the disk does not fill; an older one goes only when no run has used it for a day (a run
# touches each cache it uses, and lasts at most its --minutes), so a concurrent run never loses the cache it is using.
for kind in venv-sd nm; do
	ls -1dt "$CACHE/$kind"-* 2>/dev/null | tail -n +4 | while read -r old; do [ -n "$(find "$old" -maxdepth 0 -mmin +1440)" ] && rm -rf "$old"; done
done

phase "checkout ${SHA:0:12}"
quiet git clone -q --shared "$ROOT/$WHICH/repo.git" "$RUN/src" && quiet git -C "$RUN/src" checkout -q --detach "$SHA" \
	|| { say "checkout failed"; exit 1; }
cd "$RUN/src" || exit 1

# The caches and tools are shared by concurrent runs: one run builds at a time, and the others find it done.
build_lock() { exec 8>"$ROOT/.lock-build"; flock -w 1800 8 || { say "waited 30 min for another run's cache build"; exit 1; }; }
build_unlock() { exec 8>&-; }

ensure_node() {
	local dir="$TOOLS/node-v$NODE_VERSION-linux-x64"
	build_lock
	if [ ! -x "$dir/bin/node" ]; then
		phase "installing Node $NODE_VERSION into $TOOLS (once)"
		( cd "$TOOLS" && curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ ) >> "$LOG" 2>&1 \
			|| { say "could not install Node"; exit 1; }
	fi
	build_unlock
	export PATH="$dir/bin:$PATH"
}

ensure_tesseract() {
	# Tesseract reads text in the eval-image scorer's test; the host has none and no root, so its packages are unpacked here.
	local dir="$TOOLS/tesseract"
	build_lock
	if [ ! -x "$dir/usr/bin/tesseract" ]; then
		phase "installing Tesseract into $dir (once)"
		local tmp; tmp="$(mktemp -d)"
		( cd "$tmp" && apt-get download tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd libtesseract5 liblept5 libgif7 \
			&& mkdir -p "$dir" && for deb in ./*.deb; do dpkg -x "$deb" "$dir"; done ) >> "$LOG" 2>&1 \
			|| { say "could not install Tesseract"; rm -rf "$tmp"; exit 1; }
		rm -rf "$tmp"
	fi
	build_unlock
	export PATH="$dir/usr/bin:$PATH" LD_LIBRARY_PATH="$dir/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
		TESSDATA_PREFIX="$dir/usr/share/tesseract-ocr/5/tessdata"
}

ensure_playwright() {
	# playwright-core and its headless Chromium, user-locally and cached by version; the host has Chromium's libraries.
	local dir="$TOOLS/playwright-$PLAYWRIGHT_VERSION"
	build_lock
	if [ ! -f "$dir/.complete" ]; then
		phase "installing playwright-core $PLAYWRIGHT_VERSION and its headless Chromium into $dir (once)"
		rm -rf "$dir"; mkdir -p "$dir"
		( cd "$dir" && npm install --no-audit --no-fund --prefix . "playwright-core@$PLAYWRIGHT_VERSION" \
			&& PLAYWRIGHT_BROWSERS_PATH="$dir/browsers" node node_modules/playwright-core/cli.js install --only-shell chromium ) >> "$LOG" 2>&1 \
			|| { say "could not install Playwright (see $LOG)"; rm -rf "$dir"; exit 1; }
		touch "$dir/.complete"
	fi
	build_unlock
	export PDS_PLAYWRIGHT="$dir" PLAYWRIGHT_BROWSERS_PATH="$dir/browsers"
}

studio() {
	ensure_node
	cd "$RUN/src/extensions/pine-drama" || exit 1
	local hash nm
	hash="$(sha256sum package-lock.json | cut -c1-16)"
	nm="$CACHE/nm-$hash"
	build_lock
	if [ ! -f "$nm/.complete" ]; then
		phase "npm ci $hash (cached by package-lock.json)"
		rm -rf "$nm"; mkdir -p "$nm"
		cp package.json package-lock.json "$nm/"
		( cd "$nm" && npm ci --no-audit --no-fund ) >> "$LOG" 2>&1 || { say "npm ci failed (see $LOG)"; rm -rf "$nm"; exit 1; }
		touch "$nm/.complete"
	fi
	build_unlock
	touch "$nm"
	ln -sfn "$nm/node_modules" node_modules

	phase "npm test (compile, then the extension's tests; $PAR test files at a time, nice 10)"
	local s failed=0 testcmd
	s=$(date +%s)
	# package.json's own test script, with this run's concurrency: one source for the command.
	testcmd="$(node -p "require('./package.json').scripts.test" | sed -E "s/--test-concurrency=[0-9]+/--test-concurrency=$PAR/")"
	# Two or more runs can go at once, so each has its own HOME (the tests write lock and settings files under it) and temp
	# folder; npm keeps its download cache in the real one.
	mkdir -p "$RUN/home" "$RUN/tmp"
	HOME="$RUN/home" TMPDIR="$RUN/tmp" npm_config_cache="$HOME/.npm" nice -n 10 bash -c "$testcmd" > "$RUN/npm-test.log" 2>&1 || failed=1
	cat "$RUN/npm-test.log" >> "$LOG"
	say "npm test: $(( $(date +%s) - s ))s: $(grep -E '^ℹ (tests|pass|fail|cancelled|skipped) ' "$RUN/npm-test.log" | tr -s ' ' | sed 's/^ℹ //' | tr '\n' ',' | sed 's/,$//')"
	grep -E '^(✖|error TS)' "$RUN/npm-test.log" | grep -v 'failing tests:' | sort -u | sed 's/^/    /' | head -40 | tee -a "$LOG"
	# The webview pages in headless Chromium with the messages the extension posts (src/test/renderSmoke.ts), on what
	# npm test compiled; within 60 s.
	ensure_playwright
	phase "render smoke: the canvas, the asset grids and the seg editor in headless Chromium"
	PDS_RENDER_SHOTS="$RUN" timeout 60 node out/test/renderSmoke.js > "$RUN/render.log" 2>&1 || failed=1
	cat "$RUN/render.log" >> "$LOG"
	grep -E '^(FAIL|render smoke:)|^    ' "$RUN/render.log" | head -40 | tee -a "$LOG"
	grep -q '^render smoke:' "$RUN/render.log" || { say "render smoke: no result (stopped at 60 s, or crashed; see $LOG)"; failed=1; }
	phase "release safety tests"
	node --test --test-concurrency="$PAR" ../../scripts/test/*.test.mjs > "$RUN/release.log" 2>&1 || { failed=1; grep -E '^✖' "$RUN/release.log" | sort -u | sed 's/^/    /' | tee -a "$LOG"; }
	cat "$RUN/release.log" >> "$LOG"
	return "$failed"
}

"$WHICH"
failed=$?
say "peak memory of this run: $(( $(cat "$RUN/peak-rss-kb" 2>/dev/null || echo 0) / 1024 )) MB (sampled every 2 s); $ACTIVE run(s) were active when it started; $PAR test processes"
phase "done: $([ "$failed" = 0 ] && echo PASSED || echo FAILED) in $(( $(date +%s) - t0 ))s; log $LOG"
exit "$failed"
