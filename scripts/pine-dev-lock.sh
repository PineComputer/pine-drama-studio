#!/usr/bin/env bash
# The host side's slots, supervision and version gate for scripts/pine-dev-test-remote.sh, in one place so a test can
# drive them (scripts/test/pineDevLock.test.mjs). Sourced, never run.
#
# A run holds one of 8 slots, a flock on ~/test-runs/.slot-<n> that its supervising shell keeps on fd 9, so the kernel
# frees the slot when that shell dies, however it dies. The run itself is that shell's child and dies with it
# (--pdeathsig), and it is stopped when its caller goes away: the caller writes a line on the run's stdin every 20 s, and
# when the lines stop for PTD_BEAT seconds or stdin ends (kill, ssh drop, the Mac sleeping), the run is stopped.
# ~/test-runs/.slot-<n>.holder names the run and its shell's pid; a holder whose pid is gone is not counted.

# Bumped with every change to how a run takes, holds or frees a slot, or what it removes on the host. The host keeps the
# highest it has seen and refuses an older runner, whose rules may no longer hold for the others.
PTD_RUNNER=5
PTD_SLOTS=8
# The host's cores, which the active runs' test processes share and never exceed together (ptd_cores).
PTD_CORES="${PTD_CORES:-$(nproc)}"
PTD_BEAT=90
PTD_OLDER="rebase onto main; this runner is older than the host's"

# ptd_gate <root>: returns 1, saying why, when a newer runner has run on this host; records this one's version otherwise.
ptd_gate() {
	local root="$1" seen
	mkdir -p "$root"
	# One gate at a time, so a runner that read an older version never writes over a newer one.
	exec 7>"$root/.gate"
	flock -w 60 7 || { echo "the runner gate stayed locked for 60 s"; exec 7>&-; return 1; }
	seen="$(cat "$root/.runner-version" 2>/dev/null || echo 0)"
	if [ "$PTD_RUNNER" -lt "$seen" ]; then echo "$PTD_OLDER (runner $PTD_RUNNER, host $seen)"; exec 7>&-; return 1; fi
	if [ "$PTD_RUNNER" -gt "$seen" ]; then echo "$PTD_RUNNER" > "$root/.runner-version.$$" && mv -f "$root/.runner-version.$$" "$root/.runner-version"; fi
	exec 7>&-
	# Runners from before the gate cannot read it: they lock ~/test-runs/.lock (one run at a time) or
	# .lock-<n>. Those names become folders, which the old code cannot open, so it stops at once and prints the holder file,
	# which says why.
	local f
	for f in .lock $(seq -f '.lock-%g' 1 "$PTD_SLOTS"); do [ -d "$root/$f" ] || { rm -f "$root/$f"; mkdir -p "$root/$f"; }; done
	echo "$PTD_OLDER" > "$root/.holder"; echo "$PTD_OLDER" > "$root/.holder-0"
}

# ptd_holders <root>: the holder lines of live runs, one per line.
ptd_holders() {
	local f line pid
	for f in "$1"/.slot-*.holder; do
		[ -f "$f" ] || continue
		line="$(cat "$f" 2>/dev/null)"; pid="$(echo "$line" | awk '{print $4}')"
		[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$line"
	done
	return 0
}

# ptd_acquire <root> <wait seconds> <repo> <run id>: sets SLOT and keeps fd 9 (the lock) open; returns 1 after the wait.
ptd_acquire() {
	local root="$1" wait="$2" repo="$3" id="$4" end said=0 s
	end=$(( $(date +%s) + wait ))
	mkdir -p "$root"
	while :; do
		for s in $(seq 1 "$PTD_SLOTS"); do
			exec 9>"$root/.slot-$s"
			if flock -n 9; then
				SLOT="$s"
				echo "$repo $id pid $$ since $(date -u +%H:%M:%SZ)" > "$root/.slot-$s.holder"
				return 0
			fi
			exec 9>&-
		done
		if [ "$said" = 0 ]; then
			echo "pine-dev has all $PTD_SLOTS slots taken ($(ptd_holders "$root" | tr '\n' ';')); waiting up to $((wait / 60)) min for one"
			said=1
		fi
		[ "$(date +%s)" -ge "$end" ] && return 1
		sleep "${PTD_POLL:-3}"   # on the host, not over ssh
	done
}

# ptd_cores <root> <slot> <wait seconds>: claims this run's test processes and sets SHARE. The claims of the live runs
# never add up to more than PTD_CORES: a run takes the cores no live run has claimed, at most PTD_CORES / the active
# runs and at most half of them, so a second run can always start at once, and at least one whenever one is free, so
# runs arriving together never all wait while cores are free; when none is free it waits, then returns 1.
# The claim is written on this run's holder line (" cores <n>"), under a lock, so two runs never count the same free
# cores; a run's claim ends with its holder (ptd_holders).
ptd_cores() {
	local root="$1" slot="$2" wait="$3" end said=0 claimed active share
	end=$(( $(date +%s) + wait ))
	while :; do
		exec 7>"$root/.cores"
		flock -w 60 7 || { echo "the core claims stayed locked for 60 s"; exec 7>&-; return 1; }
		# Only claims count. A live holder with no claim yet has taken no core: it claims under this lock and sees every claim
		# made before it. Every live holder runs this rule, since the gate refuses an older runner (ptd_gate; runner 2's
		# unclaimed holders were counted as 4, which deadlocked 8 runs that arrived together, each counting the 7 others as
		# 28 cores, 2026-11-09).
		claimed="$(ptd_holders "$root" | awk '{c = 0; for (i = 1; i < NF; i++) if ($i == "cores") c = $(i + 1); n += c} END {print n + 0}')"
		active="$(ptd_holders "$root" | wc -l)"   # this run's holder is one of them, with no claim yet
		half=$(( PTD_CORES / 2 )); [ "$half" -lt 1 ] && half=1
		share=$(( PTD_CORES / (active > 0 ? active : 1) ))
		[ "$share" -gt "$half" ] && share=$half
		[ "$share" -lt 1 ] && share=1
		[ "$share" -gt $(( PTD_CORES - claimed )) ] && share=$(( PTD_CORES - claimed ))
		if [ "$share" -ge 1 ]; then
			sed -i "s/\$/ cores $share/" "$root/.slot-$slot.holder"
			exec 7>&-
			SHARE="$share"
			return 0
		fi
		exec 7>&-
		if [ "$said" = 0 ]; then
			echo "the active runs have claimed all $PTD_CORES cores ($(ptd_holders "$root" | tr '\n' ';')); waiting up to $((wait / 60)) min"
			said=1
		fi
		[ "$(date +%s)" -ge "$end" ] && return 1
		sleep "${PTD_POLL:-3}"
	done
}

# ptd_watch_wait / ptd_unwatch_wait: the caller's heartbeat, read while this shell waits for a slot (ptd_acquire) and for
# cores (ptd_cores), as ptd_supervise reads it while the run runs. A caller that goes away (its stdin ends, or no line for
# PTD_BEAT s) ends the wait at once, so a slot or a claim is never held for a caller that is gone: before this, nothing read
# the heartbeat until the run started, and runs whose callers had gone waited out ~25 min for cores, then stopped "the
# caller went away" the moment they claimed (2026-11-09). The lines read here are the ones that piled up; ptd_supervise
# reads the rest. The slot's fd is not the watcher's, so the slot frees when this shell ends.
ptd_watch_wait() {
	exec 3<&0   # a background job's stdin is /dev/null when job control is off (ptd_supervise)
	local shell=$$
	{ while read -r -t "$PTD_BEAT" -u 3 _; do :; done; kill -TERM "$shell"; } 9>&- </dev/null >/dev/null 2>&1 &
	PTD_WAIT_WATCH=$!
	exec 3<&-
}
ptd_unwatch_wait() { kill "$PTD_WAIT_WATCH" 2>/dev/null; wait "$PTD_WAIT_WATCH" 2>/dev/null; return 0; }

# ptd_release <root> <slot>
ptd_release() { rm -f "$1/.slot-$2.holder"; }

# ptd_supervise <command...>: runs the command as this shell's child, without the slot's fd and with no stdin, while this
# shell reads the caller's heartbeat on its stdin. Returns the command's exit code, or 5 when the caller went away and
# the command was stopped (SIGTERM, which `timeout` passes to its whole process group).
ptd_supervise() {
	exec 3<&0   # a background job's stdin is /dev/null when job control is off; the heartbeat is read from fd 3
	setpriv --pdeathsig TERM "$@" 9>&- 3<&- </dev/null &
	local run=$! watch code
	# The watcher holds none of the caller's connection but the heartbeat it reads, so if this shell is killed, the
	# connection ends with it and the run (--pdeathsig), and the watcher ends when sshd closes the heartbeat.
	{ while read -r -t "$PTD_BEAT" -u 3 _; do :; done; kill -TERM "$run" 2>/dev/null; exit 5; } 9>&- </dev/null >/dev/null 2>&1 &
	watch=$!
	exec 3<&-
	wait "$run"; code=$?
	kill "$watch" 2>/dev/null; wait "$watch"; [ $? = 5 ] && code=5
	return "$code"
}

# ptd_parallel <n> <function>: runs <function> 0 .. <function> n-1 at once and waits for exactly those, never for another
# background job of the caller's (the run's memory sampler never ends, and a bare `wait` waited for it to the time limit).
ptd_parallel() {
	local n="$1" fn="$2" k pids=()
	for k in $(seq 0 "$((n - 1))"); do "$fn" "$k" & pids+=("$!"); done
	wait "${pids[@]}"
}

# ptd_finish <run dir>: what a run removes when it ends, and all it removes: its own folders (checkout, venv, home,
# temp), never another run's. Its logs stay.
ptd_finish() { find "$1" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true; }
