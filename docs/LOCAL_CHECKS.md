# Local checks and verification

## Check a committed revision

```bash
npm run check
npm run check -- --ref <commit>
npm run check -- --ref <commit> --output-dir /absolute/path/to/new-report-directory
```

The runner snapshots a committed revision into a disposable directory and runs dependency installation, build/typecheck, unit tests, and browser tests in order. The build runs in production mode so service-worker behavior matches a release; test stages run in test mode. It stops on failure and preserves stage logs and a machine-readable result. The report identifies the source revision and whether the calling checkout has pending changes. Commit changes before using this command to validate them.

Every invocation uses separate build output, a browser-test port, and a report directory. Treat a check result as evidence for the revision and run identified in that report. Keep the run's report with its task handoff so another Orca conversation can find the evidence.

This command performs local validation. CI triggers, staging, image promotion and production deployment remain follow-up work on issue #23.

## Back up a running SQLite database

```bash
mkdir -p data/backups
npm run backup -- data/sonder.db data/backups/before-change-$(date +%s).db
```

The destination filesystem must support hard links so only the completed, verified backup becomes visible. Both source and destination are explicit. The source must exist and the destination must be new. The command uses SQLite's online backup API and verifies the resulting database with `PRAGMA integrity_check`; it reports failure if the backup cannot be completed or verified.

Sonder uses WAL mode. A plain copy of `sonder.db` can omit committed transactions still held in its WAL. Use the backup command while the application is running. Keep the installation's encryption key separately with its existing secret-management process; this command copies only the database.

## Live verification

The playback and reader verification scripts share a browser-write guard. Expected progress, bookmark and preference writes are handled locally; unexpected mutations fail the check. Protection remains installed until the browser context closes. Unload beacons and mutating keepalive requests are suppressed in-page because they can bypass browser routing. Counts and error telemetry for suppressed requests may be incomplete while a document is being destroyed.

Direct API requests require separate auditing because Playwright browser routing does not intercept `context.request`. The reading-sync script deliberately calls the speech-recovery endpoint, which writes an alignment recovery output file; it is not a fully read-only check.

Use local fixture servers when changing or testing the verification tooling. The live scripts retain their deployed-site defaults, so executing one without an explicit `SONDER_VERIFY_URL` targets production. The multi-user script deliberately creates a temporary account and exercises writes under that account; its separate cleanup contract still applies.

When coordinating through Orca, assign each editing worker a separate checkout. Record the task, worktree, commit, check report and any remaining process handles in the handoff. Stop only processes owned by that run.
