# Coordinator checks

How a coordinator watches CI, stays reachable when unattended, and closes issues. Each rule came from a failure: an overnight stall, a hung check nobody noticed, and an issue closed by a partial PR.

## Watch a running check yourself

A completion watcher (`kill -0 $PID` loop, `npm run ci:run` / runner exit) never fires for a hung check, so a hang looks like "still running". Look at every live check, not at its notification. Start checks with `npm run ci:run <sha>` (or `npm run ci:run -- --status` to list the queue and each host's last probe); do not start `ci:ssh` / `ci:deck` directly.

1. Note the start time and the expected totals. Sharded browser stage: complete check about 10 minutes on WSL and 12 on lisa; install 10 s, build 10 to 40 s, unit 90 to 150 s, browser about 5 minutes. A serial browser stage (`SONDER_BROWSER_SHARDS=1`, filtered runs, hosts under 8 CPUs) takes 12 to 25 minutes.
2. At every heartbeat read, for each check: `ps -o etimes= -p <pid>` (age), `cut -d' ' -f1 /proc/loadavg` on the host over ssh, and `tail check.log` in the run directory (`/tmp/sonder-ci-*` on WSL, `~/sonder-ci-tmp/sonder-ci-*` on lisa).
3. A stage past twice its usual time, or an **idle host (load under 0.5) while a stage runs**, is a hang. Find the stuck test in `check.log` (the last `✔` line is the previous test), stop the run with `scripts/ci-stop.sh <sha>`, reproduce on that host, fix the cause, and rerun on the new tip.
4. `scripts/orca/check-progress.sh name:pidfile:host ...` does steps 1 to 3 as a Monitor and prints `SUSPICIOUS` lines (`SLOW` past `LIMIT_MIN`, default 15 minutes; `IDLE-HOST` on two idle looks in a row). It complements the heartbeat and never replaces looking.

Run new or changed tests on a many-core host (WSL, lisa) before trusting a green run from a small machine. Code that reads the CPU count (browser shards) takes a different path on 16 and 20 CPUs; the unit stage hung on both while it passed on the 4-core coordinator host.

## Before leaving a run unattended

Arm all four, then confirm each from evidence (a log line, a timestamp), not from having started it:

- an inbox Monitor on the run (`bash scripts/orca/watch-inbox.sh <run_id>` is single-shot; a Monitor loop over `node scripts/orca-check.mjs --run <run>` delivers every message and ends after 30 minutes);
- a recurring heartbeat (CronCreate, every 10 minutes) whose first action appends a UTC line to `artifacts/orca/HEARTBEAT.log`, and which re-arms the Monitors and restarts the watchdog;
- the independent watchdog: `nohup bash scripts/orca/watchdog.sh <run_id> &` writes `artifacts/orca/WATCHDOG.log` every minute (heartbeat age, unread inbox, running checks) and flags `STALE-HEARTBEAT` after 25 minutes;
- PID-based waits for deploys and checks: save `$!` when launching and loop on `kill -0 "$PID"`. Never wait with a `ps | grep` of a process name: the launcher's shell matches it and the wait never ends.

`watch-inbox.sh`, `watchdog.sh` and `check-workers.sh` (also through the `artifacts/orca/` wrappers, which pass their arguments on) take the run id as their first argument and exit 2 with a usage line (`usage: <script> <run_id>`) when it is missing or empty. None has a default run, so an unread count or worker list can never silently belong to an old run. Check the live workers of the run with `bash scripts/orca/check-workers.sh <run_id>`.

Say "running" only with that evidence, and say what you did not verify.

## Closing an issue

Before `gh pr merge` or `scripts/orca-land.sh`, read the issue body and comments and list each Proposal bullet next to the PR's evidence. If a bullet is unmet, change `Closes #N` to `Refs #N`, keep the issue open and tell the owner what remains. A PR that says it addresses "the measurement phase" must not say `Closes`. Give each worker the issue's bullets in its spec; its report must account for every one.

## Deploys

- Run `node scripts/alignment-status.mjs` (or query `alignment_jobs`) for queued, copying or processing jobs before `scripts/deploy-prod.sh`. A restart kills the running job; tell the owner first.
- Pass `--marker <string in the new code>`, `--marker-file <path in the image>` or `--no-marker`; the script refuses a deploy with none.
- The reader live check (`verify-integrated-reader.mjs`) picks its own recording: one with a finished map whose saved position is clear of the end of the book (#431; rule in `README.md`). With none it is reported as `live check skipped: ... (no suitable recording: ...)`, which is not a failure; on a partially mapped book it can fail without a regression (#349). Re-run it on a warm server before treating it as a failure of the deploy.

## When the owner restates a request

Act on it. Do not ask again for permission on work already ordered.
