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

- **Chromium (1 test)**: the touch-seek test in `playback-workflow.spec.ts`.
- **Intermittent (2 tests)**: the 409 test in `reader-theme.spec.ts`, and `users.spec.ts`.

`scripts/ci-ssh.sh` passes that file to `npm run check -- --known-failures` by default, so a WSL run with only those failures is `passed_with_known_failures` and the report includes a `knownFailures` entry. Override the path with `SONDER_CI_KNOWN_FAILURES` (a relative repository path). For a hand-run `npm run check` on the host, pass `--known-failures tests/known-failures.wsl-host.json` yourself.

## Stopping a run

Agents start checks with `npm run ci:ssh -- <sha>`. Killing the `npm` or `sh -c` wrapper does not stop `scripts/ci-ssh.sh`; the remote check keeps running until something sends TERM to the bash process.

- Each run writes its PID to `artifacts/ci/<sha>/<run-id>/ci-ssh.pid` and prints a stop line at startup.
- Stop the run with `npm run ci:stop -- <sha>` (or `bash scripts/ci-stop.sh <path-to/ci-ssh.pid>`). That sends TERM to the recorded PID and to its direct child processes (for example a blocking `ssh` poll), which lets the existing `on_signal` / `cleanup_remote` path run.
- The `ci:ssh` npm script uses `exec`, so a signal delivered to the `sh -c` child also reaches `ci-ssh.sh` when that PID is what you kill.

## Running a check on the host

- Run `npm run ci:ssh -- <sha>`, which `exec`s into `scripts/ci-ssh.sh`.
- Remote run directories (checkout, bundle, report) live under `${TMPDIR:-/tmp}` on the host unless you set `SONDER_CI_REMOTE_BASE` to an absolute path. The script logs `Remote run directory: <host>:<path>` once the directory is created.
- `scripts/ci-ssh.sh` runs preflights for loopback refusal, Playwright browsers, and WebKit packages, and detects a dead run.
- A full check takes about 4 to 5 minutes.
- Keep live verification scripts (`scripts/verify-*.mjs`) on the production machine; never run them on the host.

## Summarising a check: `scripts/ci-summary.sh`

`scripts/ci-summary.sh <ci-log | artifact dir>` (issue #289) prints a check summary in under 30 lines: commit, host, stages with status, the new and known browser failures (project, file, title, issue), and for a failed unit stage the failing test names with the first lines of each error. It works from the `[ci-ssh] Artifacts:` line of a log and from a report directory.

## Choosing a host: `scripts/ci-run.sh`

`npm run ci:run [--dispatch <id>] <commit-sha>` (issue #119) is the single entry point for committed checks. It probes the Deck (`deck@steamdeck`) and the WSL host (`192.168.1.119`), starts the check on the **first idle** host by invoking `scripts/ci-deck.sh` or `scripts/ci-ssh.sh`, and **queues behind a busy host by waiting on the runner's process** — never on a log line. It forwards the downstream runner's exit status. The runners above still work standalone; `ci-run.sh` only decides which one to call.

- **Host order**: `SONDER_CI_HOSTS` is the comma-separated list of enabled hosts in priority order (default `deck,wsl`); the rest are skipped with a `[ci-run]` note. An unknown token, an empty list, or a bad `--dispatch` id is a usage error (exit 2).
- **Busy**: a live local runner process (`ci-deck.sh` / `ci-ssh.sh` in the command line, from any checkout) marks the host busy, as does a live `check.pid` in a run directory found by the remote probe (`runs/*` on the Deck, `sonder-ci-*` on WSL). A zombie pid is not busy: `kill -0` answers for it, so every liveness check also reads the state out of `/proc/<pid>/stat`.
- **Queueing**: when no enabled host is idle and at least one is busy (including a host with a live local runner process but an unreachable ssh target), it waits behind the first busy host, polling every `SONDER_CI_POLL_INTERVAL` seconds (default 5) until that runner process exits, and starts the run then. It prints one `queued <host> <sha> log=<path>` line per queue-host change and exits 124 at `SONDER_CI_QUEUE_TIMEOUT` seconds (default 3600) without starting a run.
- **Refusal**: a commit that already has a **finished** run with a failing check result on any host is refused with exit 1 and never rerun on the other host to obtain a pass. A failing check result means `result=failed` or `result=remote_check_failed` in the run's `ci-deck-result.txt` / `ci-ssh-result.txt`, or a `passed` result whose `report.json` / `check-report.json` says the check failed. Host failures (`host_*`, `timeout`, …) did not judge the commit and do not block; a report that does not parse is not evidence and does not block either.
- **All hosts unreachable**: no enabled host is idle or busy, so it invokes the first enabled host's runner, which falls back to a local `npm run check` the way it always has.
- **Output**: one line per started or queued run on stdout — `started <host> <sha> log=<path>`, `queued <host> <sha> log=<path>`, `finished <host> <sha> exit=<rc> log=<path>` — with `[ci-run]`-prefixed diagnostics on stdout. The runner's stdout and stderr append to the log file at `artifacts/ci/<sha>/ci-run-<UTC timestamp>-<pid>.log`.
- **Dispatch**: `--dispatch <id>` (or `--dispatch=<id>`) sets `SONDER_CI_DISPATCH` for the downstream runner so the finished check is recorded on that worker history dispatch. The id is validated up front against the `scripts/lib/ci-history.sh` allowlist.
- **Exit codes**: 0 the downstream check passed; 1 the ref is not a commit or the commit already failed on a finished run; 2 usage; 124 the queue wait cap was reached; otherwise the downstream runner's exit status (see `scripts/ci-deck.sh`'s list).
- **Environment**: `SONDER_CI_HOSTS`, `SONDER_CI_DECK_HOST` (default `deck@steamdeck`), `SONDER_CI_WSL_HOST` (default `192.168.1.119`), `SONDER_CI_REMOTE_BASE` (WSL: unset uses the host's `${TMPDIR:-/tmp}`; Deck: unset uses `$HOME/sonder-ci` on the Deck), `SONDER_CI_POLL_INTERVAL`, `SONDER_CI_QUEUE_TIMEOUT`, `SONDER_CI_DISPATCH`.

## Reader e2e timing (issue #115)

When measuring whether reader waits are slow on a host or the specs are too strict, run the three instrumented specs with timing on.

The named wait ceiling is `READER_WAIT_MS` in `tests/e2e/timing.ts`: **45 s** per instrumented step (`sentenceChange`, `followHighlight`, `historyRestore`, `checkpointRestore`). Idle-machine maxima were much lower (about 103 ms–2.6 s); the 45 s ceiling covers CPU contention on slow hosts (Deck, WSL) while still failing if the condition never arrives. Assertions stay on the real condition (sentence changed, highlight updated, …); only the clock limit grew from the old 10 s Playwright defaults.

A step that takes more than **10 s** (`SLOW_STEP_MS`) still passes against the 45 s ceiling, but prints one warning line to **stderr immediately** when the step ends: `slow step <test name> <step> <ms>`. (Playwright ends workers with `process.exit()`, so a deferred beforeExit flush would never run.) With `SONDER_E2E_TIMING=1`, the same step is also appended as a JSONL timing line.

```bash
npm run build
SONDER_E2E_TIMING=1 SONDER_E2E_TIMING_FILE=test-results/e2e-timing-wsl.jsonl \
  npx playwright test tests/e2e/word-reader.spec.ts tests/e2e/reader-follow-highlight.spec.ts \
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

`scripts/ci-hosts.json` sets `maxParallel: 1` for `lisa`, `192.168.1.119` and `wsl`, so `ci-run.sh` runs one complete check per host and queues the rest. The limit came from 2026-11-07: five checks started together took lisa (20 CPUs) to load 41, and four failed only on timing in the unit stage (#314, #262):

- `ci-run tests do not mutate a hosting repo HEAD or branch` (`tests/ci-script-host.test.mjs`) failed after 60291 ms. That was the 60 s timeout on the nested `node --test` run in `tests/ci-script-host-runner.mjs`, not a wait on other checks' runners: `waitForNoForeignRunners` only counts processes under the fixture's own temp repo. The nested run now has 240 s (the outer test 300 s).
- The `ci-stop` test's wait for the remote run directory to disappear is now 30 s instead of 5 s.

A central dispatcher that admits checks by each host's free CPU, memory and disk is tracked in #365.
