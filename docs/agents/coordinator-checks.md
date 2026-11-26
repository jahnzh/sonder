# Coordinator checks

How a coordinator watches CI, stays reachable when unattended, handles its workers, lands and closes issues, and reports to the owner. Each rule came from a failure: an overnight stall, a hung check nobody noticed, and an issue closed by a partial PR.

## Watch a running check yourself

A completion watcher (`kill -0 $PID` loop, `npm run ci:run` / runner exit) never fires for a hung check, so a hang looks like "still running". Look at every live check, not at its notification. Start checks with `npm run ci:run <sha>` (or `npm run ci:run -- --status` to list the queue and each host's last probe); do not start `ci:ssh` / `ci:deck` directly. A push starts no check (#905): start the land check yourself on the merged tip.

1. Note the start time and the expected totals. Sharded browser stage: complete check about 10 minutes on WSL and 12 on lisa; install 10 s, build 10 to 40 s, unit 90 to 150 s, browser about 5 minutes. A serial browser stage (`SONDER_BROWSER_SHARDS=1`, filtered runs, hosts under 8 CPUs) takes 12 to 25 minutes.
2. At every heartbeat read, for each check: `ps -o etimes= -p <pid>` (age), `cut -d' ' -f1 /proc/loadavg` on the host over ssh, and `tail check.log` in the run directory (`/tmp/sonder-ci-*` on WSL, `~/sonder-ci-tmp/sonder-ci-*` on lisa).
3. A stage past twice its usual time, or an **idle host (load under 0.5) while a stage runs**, is a hang. Find the stuck test in `check.log` (the last `✔` line is the previous test), stop the run with `scripts/ci-stop.sh <sha>`, reproduce on that host, fix the cause, and rerun on the new tip.
4. `scripts/orca/check-progress.sh name:pidfile:host ...` does steps 1 to 3 as a Monitor and prints `SUSPICIOUS` lines (`SLOW` past `LIMIT_MIN`, default 15 minutes; `IDLE-HOST` on two idle looks in a row). It complements the heartbeat and never replaces looking.

Run new or changed tests on a many-core host (WSL, lisa) before trusting a green run from a small machine. Code that reads the CPU count (browser shards) takes a different path on 16 and 20 CPUs; the unit stage hung on both while it passed on the 4-core coordinator host.

## Before leaving a run unattended

Arm all four, then confirm each from evidence (a log line, a timestamp), not from having started it:

- an inbox Monitor on the run (`bash scripts/orca/watch-inbox.sh <run_id>` is single-shot; a Monitor loop over `node scripts/orca-check.mjs --run <run>` delivers every message and ends after 30 minutes);
- a recurring heartbeat (CronCreate, every 10 minutes) that runs `bash scripts/orca/heartbeat.sh <run_id>` (it appends the UTC line to `artifacts/orca/HEARTBEAT.log`), re-arms the Monitors and restarts the watchdog;
- the independent watchdog: `nohup bash scripts/orca/watchdog.sh <run_id> &` writes `artifacts/orca/WATCHDOG.log` every minute (heartbeat age, unread inbox, running checks) and flags `STALE-HEARTBEAT` after 25 minutes;
- PID-based waits for deploys and checks: save `$!` when launching and loop on `kill -0 "$PID"`. Never wait with a `ps | grep` of a process name: the launcher's shell matches it and the wait never ends.

`watch-inbox.sh`, `watchdog.sh` and `check-workers.sh` (also through the `artifacts/orca/` wrappers, which pass their arguments on) take the run id as their first argument and exit 2 with a usage line (`usage: <script> <run_id>`) when it is missing or empty. None has a default run, so an unread count or worker list can never silently belong to an old run. Check the live workers of the run with `bash scripts/orca/check-workers.sh <run_id>`.

Say "running" only with that evidence, and say what you did not verify.

## At every heartbeat

Run `bash scripts/orca/heartbeat.sh <run_id>`. It appends the time to `HEARTBEAT.log` and prints the unread inbox, running checks and the newest results, whether the watchdog runs, one line per worker read from its screen, memory, disk, the root filesystem's use (`df -h /`; checks refuse to start above 90 %, #791) and production health, and removes stale browser-test temp folders. Then act on what it shows:

- A worker that is not `busy`, or has an `ALERT`, has stopped without sending a message (a provider's "High Load", a usage limit, a prompt waiting for an answer). Read its screen and get it going again, or move its work to a model with quota. A count of changed files says nothing: a stalled worker still has them.
- Keep three workers running whenever there is work that does not touch the same files. Waiting for one check or one answer is no reason to leave the other slots empty (the owner asked why only one worker was running twice on 2026-11-15).
- New terminals that exit with status 1 within about 10 ms mean the Orca terminal daemon is wedged. Restarting the service does not help; the daemon itself must be restarted, which ends every session, so finish or save what is running first.

## When a worker reports done

Run `bash scripts/orca/worker-done.sh <run_id> <msg_id> <worktree path>`. It prints the report, acknowledges the delivery, stops the worker's leftover processes and copies its report files to `artifacts/orca/reports/<worktree>/`. The copy comes before anything else because a removed worktree takes its reports with it (lost once, on #411). Then:

- Merge `origin/main` into the branch by hand, conflict by conflict, and run the tests before committing the merge. A scripted conflict resolution once cut a file short and the damage was committed.
- Start the check on the merged tip. A check on a tip that cannot be merged proves nothing about what lands.
- A failure is judged at once: fix it, or, for a test that passes when rerun alone (the check does that rerun), note it as flaky and land. A check cut off by time with no failure does not hold landing. Never run a failed check again to get a pass. `scripts/stress-spec.sh` stays a tool for chasing a flaky test (see "Stress a browser test" in `docs/LOCAL_CHECKS.md`).
- Review as `AGENTS.md` "Main flow" says: fix what can happen in the owner's setup, answer the rest in one line.

## Landing

The land gate is `npm run ci:run -- --level land <sha>` (`land` is the default level): a committed revision in a `git archive` copy on a CI host. A run helper that copies the working tree to lisa (`remote-run.sh '<command>'`) is for a worker's typecheck and unit files and never stands in for it.

The coordinator lands a run's work after one land check of the merged tip (`npm run ci:run <sha>`), deploys at once (`scripts/deploy-prod.sh`) and closes the issues it delivers, without asking the owner (#905). It asks him only for an account or a product choice he would notice. The full browser suite runs nightly and never holds a landing; its failures arrive as `needs-triage` issues (`artifacts/ci/nightly/latest.json`).

`scripts/orca-land.sh` removes the worktree and deletes branches that share the landed tip. When a running worker's branch starts from that tip (a follow-up built on the branch being landed), land with `gh pr merge <n> --merge` instead and remove the worktree later.

## The alignment hosts

The coordinator does host work itself and does not leave it for the owner: `scripts/update-ctc-workers.sh <commit>` copies the worker code to WSL and lisa, tests it there, swaps it in only while the worker is idle, restarts it and keeps the two previous copies. Workers the coordinator spawns stay out of `~/sonder-ctc-worker/` and off port 3012; their specs say so.

## Disk

`scripts/orca-spawn.sh` refuses to start a worker under 15 GB free. What fills the disk between runs: old rollback images (`docker images sonder-audiobooks`; keep the three newest `before-*` tags), the build cache (`docker builder prune -f`), `artifacts/ci/` (keep the newest few), finished worktrees, and temp folders of killed browser runs. The heartbeat removes those, and `scripts/clean-temp.sh` does it on request, also while browser tests run: a folder goes only when nothing in it changed in the last 30 minutes and no running process names it on its command line, working directory, environment or open files; each folder kept is printed with the reason (#825). The heartbeat's cleaner, which also runs at the start of every browser run, prints the same lines (`removed stale browser temp: …`, `kept browser temp: … (in use by process N)` or `(changed in the last 30 min)`): in the heartbeat's output, and in a check's browser log with `[test-browser]` in front. Tests remove their own temp folders (`tests/temp-leftovers.test.mjs`).

## Stopping a run

When the owner stops a run: stop each worker with `scripts/orca-reap.sh <worktree>`, commit unfinished work on its branch as a commit marked WIP, push every branch with `SONDER_SKIP_PUSH_CI=1` (a WIP commit needs no committed check), write where each branch stands into `STATE.md` and roadmap #11, and only then stop the heartbeat, the Monitors and the watchdog. Nothing unfinished is landed.

## Reporting to the owner

Say what happened in plain words, outcome first: what works now, what does not, what you need from him. Name an issue only when he needs it to find something. Do not report counts of findings or rounds of review; say whether a real defect was found and fixed.

## Closing an issue

Before `gh pr merge` or `scripts/orca-land.sh`, read the issue body and comments and list each Proposal bullet next to the PR's evidence. If a bullet is unmet, change `Closes #N` to `Refs #N`, keep the issue open and tell the owner what remains. A PR that says it addresses "the measurement phase" must not say `Closes`. Give each worker the issue's bullets in its spec; its report must account for every one.

## Deploys

- Run `node scripts/alignment-status.mjs` (or query `alignment_jobs`) for queued, copying or processing jobs before `scripts/deploy-prod.sh`. A restart kills the running job: deploy when none runs, or name the job the deploy stopped in the report.
- Pass `--marker <string in the new code>`, `--marker-file <path in the image>` or `--no-marker`; the script refuses a deploy with none, and a `--marker` the commit's `server/` or `src/` does not hold (`git grep -F`) before anything is built, naming `--no-marker` when the commit changes none of the image's code.
- A deploy returns once the new container answers (#915); its live checks run after it in the background and roll back by themselves on a failure. Wait for their result with `scripts/deploy-wait.sh` (exit 0 passed, 1 failed or superseded) before reporting a deploy as checked, or deploy with `--wait-checks`. Run `scripts/prebuild-image.sh <sha>` in the production checkout right after landing (or keep `sonder-prebuild.timer` installed with `scripts/install-prebuild.sh`) so the deploy only swaps.
- The reader live check (`verify-integrated-reader.mjs`) picks its own recording and map: one whose saved position is clear of the end of the book and whose map carries the check's sequence (#431; rule in `README.md`). With none it is reported as `live check skipped: ... (no suitable recording: ...)`, which is not a failure until the fifth deploy in a row (then it fails and rolls back; run it on a named recording to clear the count, `docs/LOCAL_CHECKS.md`); a failed request during selection (other than a 404/410 map) is a failure, never a skip; on a partially mapped book it can fail without a regression (#349). Re-run it on a warm server before treating it as a failure of the deploy.

## When the owner restates a request

Act on it. Do not ask again for permission on work already ordered.
