# Local checks and verification

## Check a committed revision

```bash
npm run check
npm run check -- --ref <commit>
npm run check -- --ref <commit> --output-dir /absolute/path/to/new-report-directory
```

The runner snapshots a committed revision into a disposable directory and runs dependency installation, build/typecheck, unit tests, and browser tests in order. The build runs in production mode so service-worker behavior matches a release; test stages run in test mode. It stops on failure and preserves stage logs and a machine-readable result. The report identifies the source revision and whether the calling checkout has pending changes. Commit changes before using this command to validate them.

Every invocation uses separate build output, a browser-test port, and a report directory. Treat a check result as evidence for the revision and run identified in that report. Keep the run's report with its task handoff so another Orca conversation can find the evidence.

Port leases coordinate runners that use the current contender protocol. Do not overlap one with a check runner started from a revision before issue #59: a legacy runner can decide that an old lock is stale, pause, and then unlink the current runner's replacement because it does not revalidate the lock identity or observe contender records. Wait for every legacy check process to exit before starting a current runner; the current runner cannot close that mixed-version race unilaterally.

## Known failures

```bash
npm run check -- --ref <commit> --known-failures tests/known-failures.wsl-host.json
```

The browser stage always runs with `--reporter=list,json` and writes `playwright-results.json` in the report directory. `report.json` includes `browserSlowestTests` (the 10 longest tests by Playwright `results[].duration`, in milliseconds) and prints them in the summary unless `--silent`.

Without `--known-failures` the runner behaves as described above. With it, each failed test is matched by exact (project, spec file, full title) against the list; the title includes `describe` blocks joined with ` › `, as the list reporter prints it. The path is resolved against the calling checkout.

The list is `{"version":1,"entries":[...]}`. Each entry has `project`, `file` (repository path), `title`, `kind` (`environment` or `intermittent`), `reason`, and optionally `issue`. A missing, unparsable or invalid list stops the run before any stage starts.

| Result | When | Exit |
| --- | --- | --- |
| `passed` | Every stage passed. | 0 |
| `passed_with_known_failures` | The browser stage failed and every failing test is listed. | 0 |
| `failed` | Any other failure: an unlisted test, a failure in an earlier stage, or a browser failure the report cannot account for (no report, run-level errors, no failing test, mismatched counts). | 1 for a browser stage under this flag; an earlier stage keeps its own exit code |

`report.json` records the final result and a `knownFailures` object: `known` (listed failures that occurred), `new` (unlisted failures), `listedPassed` and `listedNotRun` (listed tests that passed, or did not run in this environment), and a one-line `summary`, which is also printed unless `--silent`. The stage record stays `failed` and gains `toleratedBy: "known-failures"`.

Remove an entry once its cause is fixed. A `listedPassed` entry that is `environment` is a candidate for removal; an `intermittent` one may simply have passed this time. `tests/known-failures.wsl-host.json` lists the failures seen on the WSL host (`192.168.1.119`).

This command performs local validation. CI triggers, staging and image promotion remain follow-up work on issue #23; production deployment is covered by `scripts/deploy.sh` (see [Production deployment](#production-deployment)).

## Mobile device projects

`playwright.config.ts` defines two phone-profile projects, off by default so `npm run test:browser` and `npm run check` are unchanged:

- `mobile-chrome`: Chromium with the `Pixel 7` descriptor (touch, mobile user agent, device pixel ratio, `isMobile`).
- `mobile-firefox`: Firefox with the Pixel 7 viewport, touch and user agent. Firefox does not support `isMobile`, so it is left out and there is no meta-viewport handling. Defined only when the Firefox binary exists.
- `mobile-safari`: WebKit with the `iPhone 15` descriptor. It is defined only when the Playwright WebKit binary exists, so a host without it runs the other projects alone. iOS itself is not emulated.

All run `now-playing-layout`, `device-reset`, `app`, `playback-workflow`, `integrated-reader` and `playback-speed`. Build first, because the tests serve `dist/`.

**Known failures (measured 2026-10-29 on the server):** `mobile-chrome` 27 passed, 1 failed, 6 skipped; `mobile-firefox` 15 to 18 passed, 10 to 13 failed, 6 skipped (the count varies between runs). In headless Firefox the audio never starts, so the audio-dependent tests fail: `app.spec` real playback and import/download, `integrated-reader` following narration, and six `playback-workflow` tests (Pause never appears). Firefox does report that it can play MP3 and the autoplay preferences did not help, so the cause is not established; the headless audio device is the untested candidate. `playback-speed.spec` and one `integrated-reader` test also fail in full runs on a cleanup `PUT /api/appearance` timeout, but pass alone. Treat `mobile-firefox` as a layout check until the audio cause is found; real Firefox playback is covered by the Android emulator (#66). `mobile-safari` has not run here because WebKit is not installed.

```bash
npm run build
npm run test:mobile                       # only the mobile projects, one fresh server per project, with a results table
SONDER_MOBILE=1 npm run test:browser      # desktop projects plus the mobile ones (opt-in for a check run)
```

`test:mobile` (`scripts/test-mobile.mjs`) runs each project in its own Playwright invocation because the specs import books and a second project would otherwise see the first one's library; it sets `SONDER_MOBILE=only`. `SONDER_MOBILE=1` adds the mobile projects to the default list; unset leaves them out. Specs that need a keyboard or the `min-width: 900px` layout call `skipOnMobile(condition, reason)` from `tests/e2e/mobile.ts`, so they report as skipped with the reason.

## Back up a running SQLite database

```bash
mkdir -p data/backups
npm run backup -- data/sonder.db data/backups/before-change-$(date +%s).db
```

The destination filesystem must support hard links so only the completed, verified backup becomes visible. Both source and destination are explicit. The source must exist and the destination must be new. The command uses SQLite's online backup API and verifies the resulting database with `PRAGMA integrity_check`; it reports failure if the backup cannot be completed or verified.

Sonder uses WAL mode. A plain copy of `sonder.db` can omit committed transactions still held in its WAL. Use the backup command while the application is running. Keep the installation's encryption key separately with its existing secret-management process; this command copies only the database.

## Production deployment

```bash
scripts/deploy.sh <commit> [--marker <string>]... [--skip-live-checks] [--dry-run]
```

Deploys a committed revision to the local production container (`sonder` in `compose.yaml`, image `sonder-audiobooks:local`, port 3001). Production runs on this machine and the compose build context is the working tree, so the checkout must be exactly at `<commit>` with no tracked changes before the build; the script verifies that first, then:

1. backs up the running database with the online backup API (`data/backups/before-<short>-<epoch>.db`);
2. builds `sonder-audiobooks:local` with `docker compose build sonder`;
3. verifies every `--marker` string in the built image's `/app` (server code and built client);
4. keeps the previous image tagged for rollback — it reuses an existing `sonder-audiobooks:*` tag of that image, or adds `sonder-audiobooks:before-<short>-<epoch>` when it has none;
5. recreates the container, waits for the health check, then curls `/api/health`;
6. runs the live verification scripts (reader and multi-user) unless `--skip-live-checks`; the reader check picks the most recent recording with a finished EPUB alignment map.

Exit codes: 0 success, 1 a step failed, 2 bad usage. Environment overrides: `SONDER_DEPLOY_DOCKER`, `SONDER_DEPLOY_DB`, `SONDER_DEPLOY_BACKUP_DIR`, `SONDER_DEPLOY_HEALTH_TIMEOUT`, `SONDER_DEPLOY_PORT`, `SONDER_DEPLOY_LIVE_CHECKS`.

Rollback is retagging the previous image and a no-build recreate:

```bash
docker tag sonder-audiobooks:<rollback-tag> sonder-audiobooks:local && docker compose up -d --no-build sonder
```

The script prints the exact rollback command on failure and at the end of a successful run. Record every deploy in `artifacts/orca/STATE.md` (commit, backup path, image tag, markers, live-check results).

## Live verification

The playback and reader verification scripts share a browser-write guard. Expected progress, bookmark and preference writes are handled locally; unexpected mutations fail the check. Protection remains installed until the browser context closes. Unload beacons and mutating keepalive requests are suppressed in-page because they can bypass browser routing. Counts and error telemetry for suppressed requests may be incomplete while a document is being destroyed.

Direct API requests require separate auditing because Playwright browser routing does not intercept `context.request`. The reading-sync script deliberately calls the speech-recovery endpoint, which writes an alignment recovery output file; it is not a fully read-only check.

Use local fixture servers when changing or testing the verification tooling. The live scripts retain their deployed-site defaults, so executing one without an explicit `SONDER_VERIFY_URL` targets production. The multi-user script deliberately creates a temporary account and exercises writes under that account; its separate cleanup contract still applies.

When coordinating through Orca, assign each editing worker a separate checkout. Record the task, worktree, commit, check report and any remaining process handles in the handoff. Stop only processes owned by that run.

When re-merging a branch after its earlier merge was reverted, revert the revert first (`git revert <revert-commit>`); a plain merge brings in only the commits made since. Before restarting the container, grep the build for a marker string of the change to confirm it is present.
