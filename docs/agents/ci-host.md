# WSL CI Host

Facts verified on 2026-10-28 for the remote CI host.

## Host and resources

- **Target**: `192.168.1.119`, user `jahn`.
- **Environment**: WSL2 Ubuntu on Windows (WSL 3.0.3), 16 CPUs, about 15 GB RAM, about 800 GB free disk.
- **Installed tools**: Node 24, `git`, Python 3.12 (no Docker, no `ffmpeg`).
- **Workspace**: work only under `~/sonder-replication/`. `~/sonder-replication/issue6-1793194927` (47 GB) belongs to issue #6: never touch it.

## Networking

WSL networking uses NAT instead of mirrored mode, because in mirrored mode a connection to a closed loopback port timed out instead of being refused, so Playwright's readiness probe waited forever.

SSH reaches the host through a Windows port forward set in an administrator PowerShell:

```powershell
netsh interface portproxy add v4tov4 listenport=22 listenaddress=0.0.0.0 connectport=22 connectaddress=<WSL eth0 address>
New-NetFirewallRule -DisplayName "WSL SSH" -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow
```

The WSL address changes after every `wsl --shutdown` or restart, so reapply the forward then. At the last setup it was `172.31.194.38`.

Verify SSH access and immediate loopback connection refusal:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 192.168.1.119 true
timeout 4 bash -c 'exec 3<>/dev/tcp/127.0.0.1/4399'; echo $?   # prints 1, not 124
```

## Browsers

- Playwright browsers live in `~/.cache/ms-playwright`; `chromium-1248` matches the lockfile (Playwright 1.64.1).
- WebKit requires `gstreamer1.0-plugins-ugly` and `gstreamer1.0-gl`. Because `sudo` on the host prompts for a password, ask the user to install them interactively:
  ```bash
  ssh -t 192.168.1.119 'sudo apt-get install -y --no-install-recommends gstreamer1.0-plugins-ugly gstreamer1.0-gl'
  ```
- Never run Playwright's `install-dependencies.sh` unattended: it runs `sudo apt-get install` itself.

## Known failures

Known host failures (issue #37) are listed in `tests/known-failures.wsl-host.json`:

- **Chromium (2 tests)**: the touch-seek test in `playback-workflow.spec.ts` (#37) and the failed event probe test in `reader-frame.spec.ts` (#145). Both fail on every WSL run.
- The intermittent entries (the 409 test in `reader-theme.spec.ts`, the WebKit long-press in `reader-frame.spec.ts`, and the reader ordering flakes #369 and #407) were removed on 2026-11-20 (#792): a failing test that is not listed is rerun alone, and one that passes then is reported as `flaky (passed alone)` without failing the check.
- The file itself is the full list; this section names only some entries.

`scripts/ci-ssh.sh` passes that file to `npm run check -- --known-failures` by default, so a WSL run with only those failures is `passed_with_known_failures` (or `passed_with_flaky` when other failures passed alone) and the report includes a `knownFailures` entry. Override the path with `SONDER_CI_KNOWN_FAILURES` (a relative repository path). For a hand-run `npm run check` on the host, pass `--known-failures tests/known-failures.wsl-host.json` yourself.

## Stopping a run

Start checks with `npm run ci:run -- <sha>` (see below). Killing the `npm` or `sh -c` wrapper does not stop the downstream `ci-ssh.sh` / `ci-deck.sh`; the remote check keeps running until something sends TERM to that bash process.

- Each SSH run writes its PID to `artifacts/ci/<sha>/<run-id>/ci-ssh.pid` and prints a stop line at startup.
- Stop the run with `npm run ci:stop -- <sha>` (or `bash scripts/ci-stop.sh <path-to/ci-ssh.pid>`). That sends TERM to the recorded PID and to its direct child processes (for example a blocking `ssh` poll), which lets the existing `on_signal` / `cleanup_remote` path run.
- The `ci:ssh` npm script uses `exec`, so a signal delivered to the `sh -c` child also reaches `ci-ssh.sh` when that PID is what you kill.

## Running a check on the host

- Prefer `npm run ci:run -- <sha>`, which admits the check through the central dispatcher. Use `npm run ci:ssh -- <sha>` only when debugging `scripts/ci-ssh.sh` itself.
- Remote run directories (checkout, bundle, report) live under `${TMPDIR:-/tmp}` on WSL unless you set `SONDER_CI_REMOTE_BASE`; on lisa they default to `/home/jahn/sonder-ci-tmp` from `scripts/ci-hosts.json`. The script logs `Remote run directory: <host>:<path>` once the directory is created.
- `scripts/ci-ssh.sh` runs preflights for loopback refusal, Playwright browsers, and WebKit packages, and detects a dead run.
- A full check takes about 10 minutes on lisa / WSL (install ~10 s, build ~40 s, unit ~2.5 min, browser ~6 min).
- Keep live verification scripts (`scripts/verify-*.mjs`) on the production machine; never run them on the host.

## Summarising a check: `scripts/ci-summary.sh`

`scripts/ci-summary.sh <ci-log | artifact dir>` (issue #289) prints a check summary in under 30 lines: commit, host, stages with status, the new and known browser failures (project, file, title, issue), and for a failed unit stage the failing test names with the first lines of each error. It works from the `[ci-ssh] Artifacts:` line of a log and from a report directory.

## Choosing a host: `scripts/ci-run.sh`

`npm run ci:run [--dispatch <id>] <commit-sha>` (issues #119, #365) is the **only** entry point for committed checks. `scripts/ci-push.sh` and the pre-push hook also start checks through it (both with `scripts/lib/push-dispatch.sh`). `ci:ssh` / `ci:deck` stay as the low-level runners the dispatcher calls; do not start them for ordinary committed checks. The central dispatcher (`scripts/ci-dispatch.mjs`) keeps one FIFO queue and one table of running checks under a shared state dir (`SONDER_CI_STATE_DIR`, default `${XDG_RUNTIME_DIR:-/tmp}/sonder-ci-dispatch-<uid>`), probes each host over SSH, and admits on the host with the most headroom while that host's admission rule holds.

- **Hosts**: `scripts/ci-hosts.json` lists WSL (`wsl` → `192.168.1.119`) and lisa as primary (`dispatch.order`), each with runner settings (lisa: `remoteBase`/`tmpdir` `/home/jahn/sonder-ci-tmp`, `maxWait` 3600). The Deck is `dispatch.fallback` only: used when neither WSL nor lisa has room, or when listed explicitly in `SONDER_CI_HOSTS` (every listed id becomes primary, no fallback tier).
- **Admission** (named settings under `dispatch`, overridable per host): before starting a check, probe CPUs, 1-minute load, `MemAvailable`, free space on the run's tmp dir, and live `check.pid` runs on the host. Admit when all hold, else queue:
  - `running = max(registered live runs, remote check.pid runs) < ceiling`
  - `load after admission (max(load1, running × cost.load) + cost.load) ≤ CPUs × factor`
  - `MemAvailable − recentRuns × cost.memGB ≥ cost.memGB + reserve.memGB` (`recentSeconds` covers runs whose RSS is not in MemAvailable yet)
  - `diskFree ≥ cost.diskGB + reserve.diskGB`
- **Starting costs** (2026-11-13): `factor=1.0`, `ceiling=2`, `cost={load:8, memGB:8, diskGB:3}`, `reserve={memGB:2, diskGB:10}`. A complete lisa check of `c348746` was sampled every 10 seconds: load peaked at 25.5, available memory fell from approximately 12–13 GB to 5 GB (7–8 GB used), and the run used approximately 1 GB disk. The 8 GB memory cost covers that measured peak and can limit each host to one check when memory is tight. WSL was not measured separately under a live check; the same provisional costs apply until measured. The ceiling limits each host to two checks, but simultaneous checks can still exceed the load factor once their load rises. lisa's own ceiling is 1 (`"ceiling": 1` under `lisa` in `scripts/ci-hosts.json`, 20 Nov 2026): the pool's alignment worker runs there on the CPU, at about five cores while a reading sync runs, and a second check beside it took the host to load 22 to 32 on 20 CPUs, with a browser stage of 38 minutes and two tests failing that pass on a calm host (PR #826). Remove that line to return to the shared ceiling of 2 once the alignment worker no longer shares the host. The file is read from the checkout that starts the check, so a branch obeys it once it contains this change. Five concurrent checks previously reached load 41 and caused timing failures (#314).
- **Queue**: FIFO across callers (directory lock + ticket files). A queued check waits PID-based (never `ps | grep`) and is admitted as soon as any host has room. Prints `queued <sha> position=N log=…` / `started <host> <sha> log=…` / `finished <host> <sha> exit=… log=…`. Exits 124 at `SONDER_CI_QUEUE_TIMEOUT` (default 3600).
- **Old artifacts and a full disk** (#791): every start first removes `artifacts/ci/<sha>/` directories whose newest entry is older than `SONDER_CI_ARTIFACT_HOURS` (default 6), printing `pruned <dir>`. It never removes the directory of a check the dispatcher has running or queued, of the commit being started (its finished runs decide the refusal below), or one holding a live `*.pid` file. Then, while the filesystem of the checkout is above `SONDER_CI_DISK_MAX_PERCENT` (default 90) use, it refuses with `disk at N%: free space before checks` and `refused disk_full <sha>`, exit 8, before taking a queue slot. `ci-ssh.sh` and `ci-deck.sh` repeat the disk check just before the bundle and record `result=disk_full` (exit 8) instead of `host_bundle_failed`.
- **Status**: `npm run ci:run -- --status` lists running and queued checks (host, sha, age) and each host's last probe (load, memory, disk, or skip reason).
- **Refusal**: a commit that already has a **finished** run with a failing check result on any host is refused with exit 1 and never rerun on the other host to obtain a pass. A failing check result means `result=failed` or `result=remote_check_failed` in the run's `ci-deck-result.txt` / `ci-ssh-result.txt`, or a `passed` result whose `report.json` / `check-report.json` says the check failed. Host failures (`host_*`, `timeout`, …) did not judge the commit and do not block; a report that does not parse is not evidence and does not block either.
- **All hosts unreachable**: when no checks are running, the first enabled host's runner is invoked and falls back to a local `npm run check` the way it always has.
- **Dispatch**: `--dispatch <id>` (or `--dispatch=<id>`) sets `SONDER_CI_DISPATCH` for the downstream runner so the finished check is recorded on that worker history dispatch. The id is validated up front against the `scripts/lib/ci-history.sh` allowlist.
- **Exit codes**: 0 the downstream check passed; 1 the ref is not a commit or the commit already failed on a finished run; 2 usage; 8 the disk is full (`disk_full`); 124 the queue wait cap was reached; otherwise the downstream runner's exit status.
- **Environment**: `SONDER_CI_HOSTS`, `SONDER_CI_WSL_HOST` / `SONDER_CI_LISA_HOST` / `SONDER_CI_DECK_HOST`, `SONDER_CI_REMOTE_BASE`, `SONDER_CI_STATE_DIR`, `SONDER_CI_HOST_CONFIG`, `SONDER_CI_POLL_INTERVAL`, `SONDER_CI_QUEUE_TIMEOUT`, `SONDER_CI_ARTIFACT_HOURS`, `SONDER_CI_DISK_MAX_PERCENT`, `SONDER_CI_DISPATCH`.

## Reader e2e timing (issue #115)

When measuring whether reader waits are slow on a host or the specs are too strict, run the two instrumented specs with timing on.

The named wait ceiling is `READER_WAIT_MS` in `tests/e2e/timing.ts`: **45 s** per instrumented step (`sentenceChange`, `followHighlight`, `historyRestore`, `checkpointRestore`). Idle-machine maxima were much lower (about 103 ms–2.6 s); the 45 s ceiling covers CPU contention on slow hosts (Deck, WSL) while still failing if the condition never arrives. Assertions stay on the real condition (sentence changed, highlight updated, …); only the clock limit grew from the old 10 s Playwright defaults.

A step that takes more than **10 s** (`SLOW_STEP_MS`) still passes against the 45 s ceiling, but prints one warning line to **stderr immediately** when the step ends: `slow step <test name> <step> <ms>`. (Playwright ends workers with `process.exit()`, so a deferred beforeExit flush would never run.) With `SONDER_E2E_TIMING=1`, the same step is also appended as a JSONL timing line.

```bash
npm run build
SONDER_E2E_TIMING=1 SONDER_E2E_TIMING_FILE=test-results/e2e-timing-wsl.jsonl \
  npx playwright test tests/e2e/reader-follow-highlight.spec.ts \
  tests/e2e/position-history.spec.ts
```

On the Deck, use a different file (for example `test-results/e2e-timing-deck.jsonl`) the same way after `npm run build`. Without `SONDER_E2E_TIMING=1` nothing is written to the timing file (slow-step stderr warnings still print). Default file when the env var is set but `SONDER_E2E_TIMING_FILE` is unset: `test-results/e2e-timing.jsonl`. Playwright empties `test-results/` at the start of each run, so for repeated local runs (or when keeping the file after the process exits) set `SONDER_E2E_TIMING_FILE` to a path outside that directory, for example under `artifacts/`.

Summarise one or more runs with a host label:

```bash
node scripts/summarize-e2e-timing.mjs --label wsl test-results/e2e-timing-wsl.jsonl \
  --label deck test-results/e2e-timing-deck.jsonl
```

Each step prints count, median, p90 and max in ms; steps whose max is above 10 s (`SLOW_STEP_MS`) are flagged `SLOW`. Steps recorded: `sentence-change`, `checkpoint-restore`, `follow-highlight`, `history-restore`.

## Parallel alignment workers

Parallel alignment workers need one `MEDIA_ROOT` each (hard-link the inputs); see the speech-sample issue (#291). When multiple workers share a single `MEDIA_ROOT`, intermediate alignment files collide or get deleted across processes. Hard-linking the input media into separate `MEDIA_ROOT` directories allows parallel execution without duplicating audio storage.

## Parallel checks per host

`ci-run.sh` no longer uses a static one-per-host cap. Admission (above) keeps projected load at or below `CPUs × factor` so timing-sensitive unit tests stay green. The overload that motivated the old `maxParallel: 1` (still present on host entries for `ci-ssh.sh` lookups, unused by the dispatcher) was 2026-11-07: five checks started together took lisa (20 CPUs) to load 41, and four failed only on timing in the unit stage (#314, #262):

- `ci-run tests do not mutate a hosting repo HEAD or branch` (`tests/ci-script-host.test.mjs`) failed after 60291 ms. That was the 60 s timeout on the nested `node --test` run in `tests/ci-script-host-runner.mjs`. The nested run now has 240 s (the outer test 300 s).
- The `ci-stop` test's wait for the remote run directory to disappear is now 30 s instead of 5 s.
