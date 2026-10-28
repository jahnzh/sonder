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

- **WebKit (4 tests)**: `device-reset`, and `now-playing-layout` reader-first at 360, 390, and 430 px.
- **Chromium (1 test)**: the touch-seek test in `playback-workflow.spec.ts`.
- **Intermittent (2 tests)**: the 409 test in `reader-theme.spec.ts`, and `users.spec.ts`.

Pass `tests/known-failures.wsl-host.json` to `npm run check -- --known-failures <file>` so that a run with only those failures passes.

## Running a check on the host

- Run `npm run ci:ssh <sha>`, which invokes `scripts/ci-ssh.sh`.
- `scripts/ci-ssh.sh` runs preflights for loopback refusal, Playwright browsers, and WebKit packages, and detects a dead run.
- A full check takes about 4 to 5 minutes.
- Keep live verification scripts (`scripts/verify-*.mjs`) on the production machine; never run them on the host.
