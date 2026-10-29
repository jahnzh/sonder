# Steam Deck CI Host

Facts verified on 2026-10-29 for the second remote CI host. It is on when the WSL host (`docs/agents/ci-host.md`) is off.

## Host and resources

- **Target**: `deck@steamdeck` (192.168.1.111), SteamOS, rootless Podman 6.0.2, Git 2.55, no `sudo`.
- **Image**: `mcr.microsoft.com/playwright:v1.64.1-noble` (2.54 GB). The tag must match the Playwright version in `package-lock.json`.
- **Workspace**: `~/sonder-ci/` (`/home/deck/sonder-ci`). It holds `cache/npm`, the pilot's leftovers, and one directory per run under `runs/`. About 128 GB are free on `/home`.
- **Keep-awake**: the user service `~/.config/systemd/user/keep-awake.service` holds a `systemd-inhibit` block on sleep, idle and the lid switch (`sleep infinity`). Linger is enabled for `deck`, so the service starts at boot without a login. Check with `systemctl --user is-active keep-awake` on the Deck.

## Running a check

```bash
npm run ci:deck <sha>
```

`scripts/ci-deck.sh` follows `scripts/ci-ssh.sh`: it sends a Git bundle, runs detached, polls, retrieves the report into `artifacts/ci/<sha>/<run>/`, posts the commit status with context `ci/deck`, and cleans up.

1. **Preflights** (read `deck-preflight.txt` in the artifacts): `podman` present; the image present, pulled when missing; free disk above `SONDER_CI_MIN_DISK_GB` (default 10); the lockfile's Playwright version matches the image tag. A `sonder-ci-run-*` container whose run directory is gone, or older than the wait cap, is printed as `stale_container=` and **left alone**: inspect it on the Deck with `podman ps -a` and remove it by hand.
2. **Unpack**: the bundle is cloned into a fresh `~/sonder-ci/runs/<sha7>-<random>/checkout` and the commit checked out. It must be a real clone because `npm run check --ref` resolves the commit and runs `git archive` in it.
3. **Run**: the fixed command below, as a transient `systemd-run --user` unit named like the container (a `setsid nohup` child is killed when the SSH session ends on SteamOS), with its exit status written to `check.exit`.
4. **Cleanup**: the script stops only this run's process group, runs `podman rm -f --ignore sonder-ci-run-<sha7>-<random>` and removes only `runs/<sha7>-<random>`. The image and `cache/npm` stay.

The container is named `sonder-ci-run-<sha7>-<random>`, using the same `<sha7>-<random>` as the run directory. No `.env`, no `data/`, no production media and no `verify-*.mjs` exist in the container.

### The fixed command

```bash
podman run --rm --name sonder-ci-run-<id> --cpus 2 --memory 6g --pids-limit 2048 --shm-size 1g \
  --security-opt no-new-privileges --env NPM_CONFIG_CACHE=/pilot/cache/npm \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --env CI=1 --volume "$HOME/sonder-ci:/pilot:rw" \
  mcr.microsoft.com/playwright:v1.64.1-noble bash -lc \
  'cd /pilot/runs/<id>/checkout && npm ci && npm run check -- --ref <sha> --known-failures tests/known-failures.wsl-host.json --output-dir /pilot/runs/<id>/report'
```

**Never add `--cap-drop ALL`**: Firefox then crashes with `Target crashed` under rootless Podman on SteamOS.

## Exit codes

As in `ci-ssh.sh`: 0 passed; 1 the check failed (or its own exit status); 2 usage; 4 the run never started or died (including podman exit 125); 5 SSH lost after the run began; 124 wait cap reached. Preflight codes: 3 podman missing; 6 image missing and not pullable, or not matching the lockfile; 7 free disk below the threshold. An unreachable Deck at the start falls back to a local `npm run check`. A failure on the Deck is a failure: do not rerun elsewhere to get a pass.

Environment overrides: `SONDER_CI_HOST`, `SONDER_CI_REMOTE_BASE`, `SONDER_CI_IMAGE`, `SONDER_CI_MIN_DISK_GB`, `SONDER_CI_KNOWN_FAILURES`, `SONDER_CI_MAX_WAIT`, `SONDER_CI_POLL_INTERVAL`, `SONDER_CI_POST_STATUS`.

## Differences from the WSL host

- **Isolation**: each run is a container with a CPU, memory and PID limit, and the Playwright image supplies the browsers and their system libraries. There are no browser or WebKit package preflights, and no loopback preflight (the container has its own loopback).
- **Browsers**: the image ships Chromium, Firefox and WebKit, and `playwright.config.ts` enables each one that exists. The Deck runs 91 tests where the WSL host runs 80.
- **Known failures**: the same `tests/known-failures.wsl-host.json`. Its four WebKit failures are known (#37); the pilot returned `passed_with_known_failures` with 5 known failures and 0 new.
- **Duration**: Chromium alone takes about 4 minutes, in line with WSL.
- **Hardware**: a handheld that shares its disk with the user's games. Keep `--cpus 2 --memory 6g`, and never run two checks at once.
