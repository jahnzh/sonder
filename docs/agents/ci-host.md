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

## Running a check on the host

- Run `npm run ci:ssh <sha>`, which invokes `scripts/ci-ssh.sh`.
- `scripts/ci-ssh.sh` runs preflights for loopback refusal, Playwright browsers, and WebKit packages, and detects a dead run.
- A full check takes about 4 to 5 minutes.
- Keep live verification scripts (`scripts/verify-*.mjs`) on the production machine; never run them on the host.

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
