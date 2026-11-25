# Local checks and verification

## Check a committed revision

```bash
npm run check
npm run check -- --ref <commit>
npm run check -- --ref <commit> --output-dir /absolute/path/to/new-report-directory
npm run check -- --bail
```

`--output-dir` must be a directory that does not exist yet (the runner refuses one that holds another run's files and prints why), with one exception: a directory holding only `ci-ssh.pid`, which `scripts/ci-ssh.sh` makes for its own run and hands to its local fallback; one run takes it (it writes `check-local.claim` in it) and a second is refused. Just before its first stage the runner writes `stage-started` into the report directory: a failed run without that file ended in setup and judged nothing, and `scripts/ci-ssh.sh` / `ci-deck.sh` record such a fallback as `result=local_setup_failed` instead of `failed` (#887).

The runner snapshots a committed revision into a disposable directory and runs dependency installation, build/typecheck, unit tests, and browser tests in order. The build runs in production mode so service-worker behavior matches a release; test stages run in test mode. Install or build failures stop the run, but a unit failure still runs the browser stage so the report captures both results. The overall result remains failed and retains the unit exit code even if the browser stage also fails. Use `--bail` to stop after the first failed stage. The runner preserves stage logs and a machine-readable result. The report identifies the source revision and whether the calling checkout has pending changes. Commit changes before using this command to validate them.

The runner compares the selected commit with its merge base with the calling checkout's `origin/main` and selects added, modified, or renamed `tests/e2e/**/*.spec.*` files. Deleted specs, other files, and uncommitted changes are excluded. Only when asked, with `--repeat-changed` or `SONDER_CHECK_REPEAT_CHANGED=1` (off by default since #904; a dispatched check never asks), it runs those specs after the full browser suite with `--repeat-each=2 --workers=1` on a browser-test server of their own, reported as `browser-changed-repeat` with its own stage log: a tool for chasing a flaky test, not a gate. It must pass even when a known-failures list is used. If no spec changed, the stage does not run.

There is no separate ordered stage any more: with `--repeat-each=2` and one worker Playwright runs, project by project, all the files in order and then all of them in order again, so the first pass is the complete files once, in order, on one worker and a fresh server, which is what `browser-changed-ordered` ran after it (a third pass, 10 minutes on lisa for 26 specs). A unit test runs real Playwright over two fixture files in two projects and fails if a later version orders the repeats otherwise (`tests/check-local.test.mjs`, "the repeat stage's first pass…").

**A spec whose only change is its `// @projects` line is repeated in the projects it gained.** When everything after that first line is byte for byte what it was at the merge base with `origin/main`, the tests are the same and the projects it already had ran them before; only the gained projects run something new, so the stage runs the spec with `--project=<gained>` and nowhere else (`gainedProjects` in `scripts/check-local-support.mjs`). Any other changed byte, a new file, or a line that only lost projects is repeated in every project. The stage's command line says how many specs were narrowed.

**The stage runs in parts (#845).** With more than one changed spec the files are dealt into parts of about equal work (`partitionSpecs` in `scripts/check-local-support.mjs`; a spec's weight is the seconds its tests took in the browser stage just before, on this host; when that stage's report lacks a changed file, its tests times the projects it runs in), and the stage runs its parts at the same time: each part is its own `playwright test` of its own files with one worker, on its own server port, temp state and output directory (`SONDER_BROWSER_PARTS`, `scripts/test-browser.mjs`). A file is never split and `--shard` is not used, so the specs of a part run in file order on one worker and one server, and then again on that server. What a part does not have is the specs of the other parts before it on the same server. The number of parts is the number of shards the browser stage has on that host (6 on lisa, 5 on WSL, 1 on the production machine; `SONDER_BROWSER_CHANGED_SHARDS` sets it by hand). It was eight on lisa for two measured checks, and each failed on one Firefox audio test of the changed specs that passes on one worker alone; at the browser stage's width nothing of that kind was seen. The stage's log starts with the parts' sizes, and its lines carry `[part i/N]`.

**A browser stage that runs too long is stopped (#904).** Past 1.5 times the dispatcher's estimate of the browser stage (`scripts/ci-run.sh` passes the admitted host's `browser=` figure as `SONDER_BROWSER_ESTIMATE_SECONDS`), or 40 minutes without one, the check stops the stage, records it failed with `tooSlow` in `report.json`, and prints the 10 slowest tests and spec files so far; nothing is rerun alone. A check the runner's cap does end says where it was: "The check was cut off in stage 4 of 4, browser: 164 of 1122 test runs done (164 passed, 0 failed, 0 skipped)", in the runner's output, as `cut_off=` in `ci-ssh-result.txt` and in the commit status.

**The size of a browser test (#904).** A test takes at most 30 s (Playwright's default timeout in `playwright.config.ts`) and a loop over pages, parts or turns at most 100 steps. `scripts/check-test-limits.mjs`, run by `tests/browser-test-limits.test.mjs` in the unit stage, fails on a spec that raises a test over 30 s (`test.setTimeout`, `test.slow`, a `timeout:` option) or loops more than that, naming file and line; a line that names `LONG_READS` is an opt-in long read (`SONDER_LONG_READS=1`), outside the check. The files not cut yet are listed in `tests/e2e/slow-tests.json` with their reason; the list only shrinks.

**Nothing of a check stays running.** Playwright starts its web server (`node --import tsx tests/browser-server.ts`) in a process group of its own, so stopping a stage, which kills the stage's process group, does not reach it when Playwright is killed before it has stopped the server itself; ten such servers stood on lisa for up to 27 hours, each holding its port. A check therefore stops, on its way out, every process whose working directory is inside its own checkout folder (`stopProcessesUnder` in `scripts/check-local-support.mjs`: SIGTERM, a moment, SIGKILL) and says how many it stopped. It writes the folder's name into its report folder (`checkout-dir`), and the SSH runner's cleanup does the same sweep with it after it has killed the check, for the case that the check itself was killed before it could.

**A check host's Python.** The unit stage runs the alignment worker's Python tests (`tests/worker`, through `tests/0-worker-python.test.ts`), and on a check host they must run, not be skipped. Until 21 Nov 2026 WSL's Python had no numpy: it skipped 81 of the 265 tests, the alignment tests of `test_book_align.py` among them, and passed; with every check sent to WSL they ran nowhere. Setting up a check host therefore includes:

```bash
ssh <host> 'bash -s' < scripts/setup-check-python.sh     # a virtual environment in ~/sonder-ci-python: numpy, fastapi, uvicorn, httpx
```

No system package and no password; only `python3 -m venv` must work (the `python3-venv` package). Then name the interpreter as the host's `workerPython` in `scripts/ci-hosts.json` (WSL: `/home/jahn/sonder-ci-python/bin/python3`; lisa's own `/usr/bin/python3` has the modules). `scripts/ci-ssh.sh` hands it to the check as `SONDER_WORKER_PYTHON`, the check to its unit stage, and with it the tests FAIL when the interpreter does not run, cannot import those modules, or skips a test for want of one, each time naming this step. **torch, where a host declares it (#878).** 33 of the tests need torch: the real whole-book stages of `test_book_pipeline.py` and four of the ctc tests. A host says whether its interpreter has it, `"workerTorch": true` or `false` in `scripts/ci-hosts.json`, and the check's summary says which in one line. WSL has it (`ssh <host> 'bash -s -- --torch' < scripts/setup-check-python.sh`: the CPU build of the worker's pinned torch, 184 MB to download, the environment 935 MB on disk), and there those tests fail instead of skip, also when ffmpeg is missing. lisa declares `false`: its check Python is 3.14, for which the pinned torch has no build, and every check of it ends with "Worker tests: run with /usr/bin/python3 WITHOUT torch: the 33 tests of the whole-book stages that need it were skipped on this host". The tests never use a GPU: the build is the CPU one and they run with `CUDA_VISIBLE_DEVICES` empty, so the alignment worker's card on WSL is not touched. One test stays skipped everywhere: the numba kernel of `worker/book_align.py`, which no worker environment has either. A machine that names no interpreter (a developer's, the production machine's local check) runs the tests with `python3` and skips what it cannot run. The Deck names none.

**The unit stage on lisa.** `tests/0-worker-python.test.ts` runs the alignment worker's Python tests. The alignment tests of `tests/worker/test_book_align.py` take two minutes on one core there (no numba, so the kernels run as plain Python). Node starts the test files in the order of their names; as `worker-python.test.ts` the file started last and the stage waited for it: 220 s on lisa, of which the other files needed 149. The file's name now sorts first, and the heavy module's classes each run in a Python process of their own beside one process for the other modules (in their old order: several of them time things). Measured on lisa, the whole unit stage alone: 223, 218 and 220 s before, 125 and 127 s after, the same tests. A module that grows heavy is added to `HEAVY` in that file; the file checks that the classes' runs add up to the module's whole count.

**The bar: a check ends within 30 minutes, and says at dispatch when it would not.** `npm run ci:run <sha>` first prints what the check will take on each host (`scripts/check-estimate.mjs`): the fixed stages, the browser stage's longest shard and the repeat stage's longest part, from `tests/e2e/spec-seconds.json` and each host's `estimate` entry in `scripts/ci-hosts.json` (`fixedSeconds`, `speed` against lisa's seconds, `shards`, `startSeconds`):

```text
estimate wsl 14.5min fixed=85s browser=786s repeat=0s 1a2b3c4
estimate lisa 28.4min fixed=308s browser=1396s repeat=0s 1a2b3c4
estimate deck none: no estimate entry for this host 1a2b3c4
bar 30.0min fits=wsl,lisa,deck judged=wsl,lisa over=none 1a2b3c4
```

A host the check would run over the bar on takes no part in the dispatch ("over the bar on lisa: the check waits for wsl"). A check that fits on no host with figures is refused at once, exit 9, with the figures ("refused over_bar <sha>: …"), and only `SONDER_CI_OVER_BAR=1` runs it; that setting is the coordinator's to give, not a worker's. The bar is `dispatch.barSeconds` in `scripts/ci-hosts.json` (1800), or `SONDER_CI_BAR_SECONDS` for one run. A host without an `estimate` entry (the Deck) is not judged and stays the fallback it was; a commit without the table is judged on no host. The figures are kept true by the checks themselves: when a check that passed took more than a tenth (and more than half a minute) more or less than estimated in its fixed stages, its browser stage or its repeat stage, `ci:run` says so after it and names what to refresh, for example "estimate off on lisa: the browser stage estimated 1396 s, took 1603 s (+15 %). Refresh the table of times from this check: node scripts/spec-seconds.mjs artifacts/ci/<sha>/<run>/playwright-results.json \"lisa, 70c08ca, 2026-11-21\"". The table holds the seconds of the host whose `speed` is 1 (lisa); on another host the figure to set is its `speed`. A host's `estimate.shards` is also the number of shards its check runs with (`scripts/ci-ssh.sh` passes it as `SONDER_BROWSER_SHARDS`), so a check runs at the width it was judged at: 6 on lisa, 5 on WSL. (lisa at 8 was tried on 21 Nov 2026, commit `ca686f6`: the browser stage took 1,360 s instead of 1,603 s, and two tests failed in it, so it stays at 6 until 8 is shown clean. At 6, with the table measured after #868, an ordinary check is about 32 minutes on lisa, over the bar: lisa takes no check and they wait for WSL, where one is about 17 minutes.)

`report.json` records the selected paths and the `origin/main` commit in `changedBrowserSpecs`. The local `origin/main` reference must exist and be current enough for the comparison; the check fails setup if it is missing or has no common ancestor with the selected commit. The SSH and Deck CI runners carry this reference into their temporary checkouts.

The app's background loops (download queue, copies to the server, series acquisition, Hardcover sync, alignment processor, Activity sampler) run in one runner, `server/background-runner.ts`. A unit test that must not have a loop tick on its own creates the app with `createApp({ background: { manual: ["series-acquisition"] } })` (or `manual: true` for every loop) and runs a tick with `backgroundRunner(app).tick(id)`, which applies the same pause check as the timer, or calls the feature function directly (`tickSeriesAcquisition()` in `server/series-acquisition.ts`).

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
| `passed_with_known_failures` | Earlier stages passed, the browser stage failed and every failing test is listed. | 0 |
| `passed_with_flaky` | Earlier stages passed, the browser stage failed, and every failing test is listed or passed when rerun alone (see below). Also without `--known-failures`. | 0 |
| `failed` | Any other failure: an unlisted test that failed again alone or was not rerun, a failure in an earlier stage, or a browser failure the report cannot account for (no report, run-level errors, interrupted tests, no failing test, mismatched counts). | 1 for a browser stage under this flag; otherwise the stage keeps its own exit code |

`report.json` records the final result and a `knownFailures` object: `known` (listed failures that occurred), `new` (unlisted failures), `listedPassed` and `listedNotRun` (listed tests that passed, or did not run in this environment), and a one-line `summary`, which is also printed unless `--silent`. When the browser failure is tolerated as the overall result, the stage record stays `failed` and gains `toleratedBy: "known-failures"`. After a unit failure, the browser report is still classified, but known browser failures do not make the overall run pass.

### Rerun a failing test alone (#792)

Under load many browser tests fail that pass on their own. So when the full browser suite fails, the check reruns each failure that is not on the known-failures list once, alone, before it calls it a failure: one `npm run test:browser -- --workers=1 --retries=0 --project=<its project> --reporter=list,json --output=test-results-rerun-<n> <file>:<line>` per test, one after the other, with the same port. Each rerun keeps its log (`stage-4-browser-rerun-<n>.log`), its JSON report (`playwright-rerun-<n>.json`) and its traces (`test-results-rerun-<n>/`) in the report directory.

- A test that passes alone is `flaky (passed alone)` and keeps the first error of the full run. One that fails again, or that the rerun does not run or report, is a failure.
- If no failure is left the result is `passed_with_flaky` (exit 0), also when some failures were known; the browser stage record stays `failed` with `toleratedBy: "rerun-alone"`.
- The rerun is bounded: with more than `--max-reruns <n>` unlisted failures (default 12) nothing is rerun and the check fails as before. `--max-reruns 0` turns reruns off.
- Nothing is rerun after an earlier stage failed, when the report cannot account for the failure (run-level errors, interrupted tests, mismatched counts), or for the changed-spec stages, which already run with one worker.

`report.json` has `browserFailures` for every classified browser run: `result`, `summary`, and `new`, `flaky` and `known`, one entry per test; `knownFailures` gains `flaky` too. `browserReruns` records the bound, why nothing was rerun (`skipped`), and per rerun its command, exit code, outcome (`passed_alone` or `failed_again`), log and report. The printed summary and `scripts/ci-summary.sh` list new failures, flaky (passed alone) and known, one line per test, in under 30 lines. Worker history records the result as `pass_with_flaky`.

Remove an entry once its cause is fixed. An `intermittent` failure does not belong on the list any more: the rerun reports it as flaky, and a listed test is never rerun, so listing it would hide a test that fails twice (`tests/known-failures.test.mjs` keeps the WSL host list free of them). A `listedPassed` entry is a candidate for removal. `tests/known-failures.wsl-host.json` lists the failures seen on the WSL host (`192.168.1.119`).

This command performs local validation. CI triggers, staging and image promotion remain follow-up work on issue #23; production deployment is covered by `scripts/deploy.sh` (see [Production deployment](#production-deployment)).

## Stress a browser test

A browser test that passes once can still fail in the full suite on a loaded host. On 2026-11-15 four new tests landed that way, and three tests written off as unreliable turned out to be defects in the app. Before a new or changed browser test lands, run it repeatedly under load:

```bash
scripts/stress-spec.sh tests/e2e/<file>.spec.ts -g "<title>" --runs 20 --load
```

Each run gets a fresh server, so the spec file does not have to be repeat-safe. `--load` keeps every CPU busy beside the runs. The script builds first (the browser tests serve `dist/`), prints the passed and failed counts, and keeps the logs of failed runs. When a run fails, decide with its trace whether a user doing the same thing at the same speed would get the wrong result (fix the app) or the test acts before the app is ready (fix the test, waiting on what a user would see).

## Which projects a spec runs in (#793)

`chromium` runs every spec. Any other project runs a spec only when the spec's first line names it: `// @projects firefox, mobile-chrome, mobile-iphone-slice14`. `playwright.config.ts` reads those lines from `tests/e2e/*.spec.ts` once at load and builds each project's `testMatch` from them, so adding a spec to a project, or a project to a spec, touches only the spec file; never add a pattern to the config. The names a spec may use are `SPEC_PROJECTS` in `tests/spec-projects.ts` (a project that exists only with a browser binary or `SONDER_MOBILE` / `SONDER_SLICE_WEBKIT` may still be named). An unknown or repeated name, `chromium`, or the line anywhere but first stops every Playwright run at load, and `tests/spec-projects.test.ts` fails on it and checks that each project of the config runs exactly the specs that name it.

**The reader's specs on the new reading view (#802).** The project `prepared-view` is Chromium with the hidden switch of the reading view set (`sonder-reader-view` in the browser's storage, as `?reader-view=prepared` leaves it), so a spec that names it runs once on today's reader and once on the view of prepared text. A spec reaches the book's text through `tests/e2e/reader-view.ts` (`bookText`, `textFrame`, `bookBody`, `expectHighlightDrawn`) and, inside the page, through `window.__readerFrames(host)` (`tests/e2e/reader-frames.ts`), never through the frame directly, so the same steps hold for both views. A test that cannot apply to the new view says so first, with `notOnPreparedView("<reason>")` (`tests/e2e/prepared-view.ts`): it is skipped in that project and the reason stands in the report. Never use it for a failure of the new view. The project and these helpers go when step 7 of the reader plan makes the view the default.

## Mobile device projects

### Sharded browser stage (#34)

`npm run test:browser` splits an unfiltered full run into parallel shards. With the table of times `tests/e2e/spec-seconds.json` (what each spec file's tests took in a full browser stage on lisa) the spec files are dealt into shards of about equal time, each shard a `playwright test` of its own files; every spec file is in exactly one shard (a unit test compares the dealt files with Playwright's own `--list`), and a spec the table does not know weighs the middle value. Without the table the run is split by `--shard=i/N`, which deals by count and left lisa's six shards between 11 and 35 minutes. Refresh the table from a check's report when the shards have drifted apart: `node scripts/spec-seconds.mjs <playwright-results.json> "lisa, <sha>, <date>"`; an old table costs time, never a test. Each shard has its own server port (`PLAYWRIGHT_PORT` + i), browser temp directory, output directory and JSON report; the reports are merged into the one file the check reads, and the shard outputs are merged into `test-results/`. `SONDER_BROWSER_SHARDS=N` (1 to 16) sets N; without it N follows the CPU count (1 below 8 CPUs, so the 4-core production host stays serial; 5 on the 16-CPU WSL host, 6 on lisa). Set `SONDER_BROWSER_SHARDS=1` to force a serial run. Filtered runs and runs with `--workers`, `--repeat-each`, `--output`, `--shard` or `--grep` (including the changed-spec stages of `check-local`) stay a single serial run. Measured on lisa (222 passed, 12 skipped): serial 1534 s, six shards 285 s.

### Browser scope follows the change (#34)

`check-local` lists the files changed against `origin/main` and chooses the browser stage scope from them (`selectBrowserScope` in `scripts/check-local-support.mjs`; the rules are the two lists above it):

| Changed files | Browser stage |
| --- | --- |
| Only docs, markdown, the Python worker and its tests, `deploy/`, Docker files, the git hooks (`.githooks/`), unit-test files (`tests/*.test.*`), or scripts other than the build, the check, the CI runners and the test runner | skipped, reason recorded |
| The above plus `server/` | Chromium project only (Firefox and WebKit run layout specs a server change cannot move) |
| Anything else: `src/`, `public/`, `tests/e2e/`, browser-test support, config and package files, `scripts/build-sw.mjs`, `scripts/test-browser.mjs`, `scripts/check-local*`, `scripts/ci-*`, `scripts/lib/`, or any file no rule lists | the whole suite |

A skipped or Chromium-only run is reported as such: `report.json` has a `selection` object, the browser stage shows `skipped (selection: ...)`, and `scripts/ci-summary.mjs` prints `browser scope:` whenever the scope is smaller than the whole suite. `--full` (or `SONDER_CHECK_FULL=1`) always runs everything; run it before a deploy and when a partial run is not enough evidence. The unit stage always runs.

`playwright.config.ts` defines two phone-profile projects, off by default so `npm run test:browser` and `npm run check` are unchanged:

- `mobile-chrome`: Chromium with the `Pixel 7` descriptor (touch, mobile user agent, device pixel ratio, `isMobile`).
- `mobile-firefox`: Firefox with the Pixel 7 viewport, touch and user agent. Firefox does not support `isMobile`, so it is left out and there is no meta-viewport handling. Defined only when the Firefox binary exists.
- `mobile-safari`: WebKit with the `iPhone 15` descriptor. It is defined only when the Playwright WebKit binary exists, so a host without it runs the other projects alone. iOS itself is not emulated.

Each runs the specs whose `// @projects` line names it (see above). Build first, because the tests serve `dist/`.

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

Deploy backups (`data/backups/before-<short>-<epoch>.db`) older than the newest 20 may be compressed in place to `before-<short>-<epoch>.db.zst` with `zstd`, each verified by SHA-256 against its original before the original is removed; nothing in Sonder lists, rotates or restores them by name (the daily backups' retention touches only the `daily-<day>.db` files its own runs recorded), and a backup with a `-wal` or `-shm` file beside it is left as it is.
To restore from a compressed one, unpack it to a new file first, `zstd -d data/backups/before-<short>-<epoch>.db.zst -o /path/to/restore.db` (the `.zst` stays), check it with `PRAGMA integrity_check`, and use that file as any other backup.

Sonder uses WAL mode. A plain copy of `sonder.db` can omit committed transactions still held in its WAL. Use the backup command while the application is running. Keep the installation's encryption key separately with its existing secret-management process; this command copies only the database.

## Production deployment

Production source lives at `/home/jahn/audiobook_streamer`: a **bare** Git repository at `.git` (`core.bare=true`) with the running app checkout as the work tree (same directory). Orca worktrees attach under `.git/worktrees/`; deploy must not export `GIT_DIR` or `GIT_WORK_TREE` into an agent shell.

From any checkout (including an Orca worktree), deploy a committed revision with:

```bash
scripts/deploy-prod.sh <commit> [--marker <string>]... [--marker-file <path>]... [--no-marker] [--skip-live-checks] [--dry-run]
```

`deploy-prod.sh` checks out `<commit>` into the production work tree and runs `scripts/deploy.sh` inside a subshell so `GIT_DIR`/`GIT_WORK_TREE` never escape to the caller. It refuses when tracked work-tree files are modified and passes through `deploy.sh` exit codes and flags (including `--dry-run`).

`scripts/deploy.sh` alone is for use **inside** the production work tree when it is already at `<commit>` with a clean index:

```bash
scripts/deploy.sh <commit> [--marker <string>]... [--marker-file <path>]... [--no-marker] [--skip-live-checks] [--dry-run]
```

Deploys a committed revision to the local production container (`sonder` in `compose.yaml`, image `sonder-audiobooks:local`, port 3001). Production runs on this machine and the compose build context is the working tree, so the checkout must be exactly at `<commit>` with no tracked changes before the build; the script verifies that first, then:

1. backs up the running database with the online backup API (`data/backups/before-<short>-<epoch>.db`);
2. tags the running image for rollback before building — it reuses an existing `sonder-audiobooks:*` tag (other than `:local`) of that image, or adds `sonder-audiobooks:before-<short>-<epoch>` when it has none; if the tag cannot be made the script stops before building and says how to roll back by rebuilding the previous commit. The build moves `:local`, so tagging afterwards loses an image whose only tag was `:local` (#153);
3. builds `sonder-audiobooks:local` with `docker compose build sonder`;
4. verifies every `--marker` string in the built image's `/app` (server code and built client) and every `--marker-file <path>` exists in the image (`docker run --rm --entrypoint test <image> -f <path>`); a failure restores the rollback `:local` tag and leaves the container running. At least one `--marker` or `--marker-file` is required: the script exits 2 ("refusing to deploy with no verification") unless `--no-marker` is given, which explicitly skips the image check for non-app changes (docs, scripts) and cannot be combined with the other two. `deploy-prod.sh` applies the same rule before touching the work tree;
5. runs the image smoke using the `sonder` service's environment, network and mounts, without starting its dependencies; the smoke checks server imports and the consensus worker, and, when `ALIGNMENT_POOL_ENABLED=1`, checks that `ssh` and `scp` are present and that every configured pool host answers `/health` and `ssh true` using the container's SSH credentials. A failure restores the rollback image's `:local` tag and leaves the existing container running;
6. recreates the container, waits for the health check, then curls `/api/health`;
7. waits for the server to settle before any live check: until `/api/health` has answered in under half a second for 60 seconds in a row. An answer that is slow, refused or an error starts the stretch again. After 300 seconds without such a stretch the script prints `not settled: … starting the live checks anyway` and goes on. `SONDER_DEPLOY_SETTLE_SECONDS` (the stretch; `0` skips the wait), `SONDER_DEPLOY_SETTLE_ANSWER` (how quick an answer must be, in seconds), `SONDER_DEPLOY_SETTLE_CEILING` and `SONDER_DEPLOY_SETTLE_INTERVAL` (how often it asks) set the four numbers. With `--skip-live-checks` there is no wait. On 20 Nov 2026 the reader check started the moment health answered, on a loaded machine, and failed a sound build because the audio did not start within 30 seconds (#822);
8. runs the live verification scripts (reader and multi-user) unless `--skip-live-checks`, every one of them even when an earlier one fails, then exits 1 listing the failures. Each check picks its own recording, never one listened to in the last 48 hours or another recording of its work (#774); `deploy.sh` passes no recording id. The reader check takes a recording that plays from the server's own copy before one that streams from TorBox or another remote source, so it does not depend on a service outside the machine when it need not (#822). No check is run again by the script: one that fails fails the deploy. `SONDER_VERIFY_RECORDING=<recording id>` names the recording instead and `deploy.sh` passes it through to every check, with `SONDER_VERIFY_ALLOW_RECENT=1` when that recording was played in the last 48 hours (without it the check refuses the recording and fails). A check that exits 3 and writes a reason to the file named by `SONDER_LIVE_CHECK_SKIP_FILE` found no recording it can run on without moving the owner's saved position (the reader check after the owner finished its only aligned book, #431): the deploy prints `live check skipped: <script> (no suitable recording: <reason>)` and does not count it as a failure. Any other non-zero exit, including 3 without a reason, is a failure.
9. prepares the library's text (#827): `scripts/prepare-library.sh` on the deployed server, after the live checks have passed or were skipped, so nothing heavy runs under a check. Its failure is printed loudly and named in the deploy's last line, and does not change the exit code: the deploy is live and checked by then.

Exit codes: 0 success (skipped live checks included), 1 a step failed, 2 bad usage. Environment overrides: `SONDER_DEPLOY_DOCKER`, `SONDER_DEPLOY_DB`, `SONDER_DEPLOY_BACKUP_DIR`, `SONDER_DEPLOY_HEALTH_TIMEOUT`, `SONDER_DEPLOY_PORT`, `SONDER_DEPLOY_LIVE_CHECKS`, and the four `SONDER_DEPLOY_SETTLE_*` settings of step 7.

Rollback is retagging the previous image and a no-build recreate:

```bash
docker tag sonder-audiobooks:<rollback-tag> sonder-audiobooks:local && docker compose up -d --no-build sonder
```

If the running image could not be tagged (or no rollback image exists), roll back by rebuilding the previous commit:

```bash
git checkout <previous-commit> && docker compose build sonder && docker compose up -d sonder
```

Before rolling back to an image older than ADR 0011 (derived work media state, issue #395), run `node scripts/materialise-media-states.mjs` from the production work tree as the last step before the recreate, because those images read a work's media state from the stored `state` and `acquisition_id` columns of `work_media_states`, which later images no longer keep current, and would otherwise show wrong or missing media states. It uses `data/sonder.db` (or `--db <path>`) and prints how many rows it wrote; `--dry-run` only counts. It opens the database file directly and waits for the write lock, so it works while the server is running and when the server cannot start. Changes made between the script and the recreate are not reflected, so stop the container first (`docker compose stop sonder`) unless the rollback is urgent.

### Deploying the alignment-worker retirement (#279)

`deploy.sh` builds and recreates only `sonder`; it never touches the alignment workers. **The workers on WSL and lisa keep running their current revision** (`worker/` of `main` before #279), which works with this server. Every request the new server sends carries `engine: "ctc"`, which that worker's `/align`, `/anchor` and `/anchor-batch` accept with the same fields (`audio`, `output`, `fragments`, `language`, `start`/`duration` or `windows`, `prefetch`, `recordingId`, `audioFingerprint`, `trackId`, `microbatch`) and answer from the same CTC pipeline; and every `/health` field the server reads (`ready`, `busy`, `stuck`, `slots`, `mediaRoot`, `ctc.engine`, `ctc.ready`, `ctc.device`, `ctc.precision`, `ctc.passageReady`, `ctc.anchorBatch`) is in that worker's answer. Its top-level `engine` still says `aeneas-1.7.3`; the server reads `ctc.engine` only. WSL's live `/health` on 2026-11-15 was `{"ready":true,"engine":"aeneas-1.7.3",...,"slots":8,...,"ctc":{"engine":"ctc-wav2vec2-base-960h-torchaudio-2.8-v2","ready":true,"device":"cuda","precision":"float16",...,"passageReady":true,"anchorBatch":true}}` (the fixture of `tests/image-smoke.test.mjs`); lisa's was not read. Updating the workers is #411: **do not run `scripts/install-ctc-workers.sh` for this deploy.**

1. **Deploy the app** with `scripts/deploy-prod.sh <commit> --marker <string>` as above. The image smoke (step 5) reads each pool host's `/health` body and fails the deploy unless the worker is ready, runs `ctc.engine` `ctc-wav2vec2-base-960h-torchaudio-2.8-v2` with its model ready, and runs on the host's device (`cuda`/`float16` on WSL, `cpu`/`float32` on lisa). Then **stop the old container**, which the new server never calls:

   ```bash
   docker stop sonder-alignment
   ```

   `compose.yaml` no longer defines it, so nothing recreates it; `docker compose up` reports it as an orphan until it is removed. Until the rollback window has passed, keep the stopped container, the `sonder-alignment:local` image and `ALIGNMENT_WORKER_URL` in `.env` (the new server ignores that value): the rollback below needs all three. After the window: `docker rm sonder-alignment`, and delete the `ALIGNMENT_WORKER_URL` line. The image can stay longer (`worker/Dockerfile.ctc-benchmark` builds on it).

2. **Rollback**, in this order (the old server needs `ALIGNMENT_WORKER_URL` and the old container for reading sync and passage recovery). Each check exits non-zero when it fails, and the `&&` chain stops there, before the old app is recreated:

   ```bash
   grep -q '^ALIGNMENT_WORKER_URL=.' .env \
     && docker start sonder-alignment \
     && curl -sf --max-time 10 http://127.0.0.1:3012/health | jq -e '.ready == true' \
     && docker tag sonder-audiobooks:<rollback-tag> sonder-audiobooks:local \
     && docker compose up -d --no-build sonder \
     && docker exec sonder sh -c 'test -n "$ALIGNMENT_WORKER_URL" && test -n "$ALIGNMENT_WORKER_TOKEN"' \
     && echo 'rollback done: reading sync configured'
   ```

   If it stops at the first line, restore `ALIGNMENT_WORKER_URL=http://127.0.0.1:3012` in `.env` and run it again. If the container was already removed, recreate it first from the previous commit's `compose.yaml` (`git show <previous-commit>:compose.yaml > /tmp/compose-prev.yaml && docker compose -f /tmp/compose-prev.yaml --project-directory . up -d --no-build alignment-worker`) and run the block again. The `/health` check waits for nothing: if the old worker is still starting, rerun the block. The last check is the old server's own availability rule (URL and token set). Then open Settings → Reading sync: "Prepare reading sync for all titles" must be enabled, without "The alignment worker is not configured on this server." This deploy does not change the workers on WSL and lisa, so the rollback does not touch them.

The script prints the exact rollback command on failure and at the end of a successful run. Record every deploy in `artifacts/orca/STATE.md` (commit, backup path, image tag, markers, live-check results).

## Prepare the library's text after a deploy (#827)

```bash
scripts/prepare-library.sh
```

`scripts/deploy.sh` runs this itself as its last step, after the live checks have passed (step 9 below): it starts the server's sweep as the administrator (through `scripts/admin-curl.sh`, on the deployed port), prints the count as it grows, and ends 0 when the library is prepared, or 1 with the names when a book could not be prepared or the wait ran out (`SONDER_PREPARE_TIMEOUT`, 1800 s in a deploy). A deploy that is live and checked is not failed by it: the result is printed, and a library that is not fully prepared is named again in the deploy's last line. `SONDER_DEPLOY_PREPARE_LIBRARY=` (empty) leaves the step out.

The server also sweeps by itself, 15 minutes after a start (`PREPARED_TEXT_FIRST_SWEEP_MINUTES`) and every hour (README "Prepared text"): that is for a restart without a deploy, and late enough to stay out from under a deploy's settle wait and live checks. Run the command by hand after a change of the Node version or whenever you want to know that the whole library is prepared. It changes nothing but the prepared-text cache, reads no page and saves no position; stopping it does not stop the sweep.

The command signs in once and keeps that session for the whole run (#858; `scripts/admin-curl.sh` keeps it in the file `SONDER_ADMIN_JAR` names, here in a temp folder of the run that is removed at its end): the server allows 10 sign-ins in 15 minutes from one address, and a sign-in for every question used them up during a deploy. Its exit code 3 means the server could not be asked (the sign-in was refused, or six answers in a row were no state of the library; the HTTP status is printed, 429 being too many sign-ins or requests). That says nothing about the library, and the deploy reports it as "THE LIBRARY'S TEXT WAS NOT CHECKED", not as an unprepared library. An answer of 429 while it waits is printed and asked again.

The copy of production that `scripts/reader-open-copy.sh` starts runs with `PREPARED_TEXT_AHEAD=0`: its media folder is read-only, so it cannot prepare a book, and it serves what production has prepared. Prepare the library on production before measuring on the copy.

`npx tsx scripts/measure-prepared-stall.ts --db data/sonder.db <edition id>...` measures, on a copy of the database, how long preparing those books holds the server's event loop (off the thread, as the server does it, and on it, as before #827) and what `extractBook` costs before it.

## Check prepared text against a library

```bash
npx tsx scripts/check-prepared-text.ts --db data/sonder.db --out artifacts/prepared-text-check.json
```

For every EPUB edition of the database it prepares the reader text (`server/prepared-text.ts`) and compares it with the stored sentences: every id once and in order, each tagged sentence equal to the stored text, and the manifest's counts equal to what the parts hold. It prints the counts (books, sentences, mismatches, books that failed and why) and, for the books with the most text (`--timings <n>`, default 3), the time to prepare from nothing and to serve the manifest and each part from the cache. `--only <edition id>` checks one book. Exit code 1 when a sentence differs or a book fails.

It may be run against the production database: it copies the database with the online backup and opens the copy, only reads the EPUB files, and prepares into a temp folder that it removes, with `MEDIA_ROOT` pointed at that folder too. It starts no server, opens no page and saves no reading or listening position.
## Compare the extractor before and after a change

A change to `extractBook` (`server/reader.ts`) or to the block rule (`src/reading-types.ts`) must leave the sentences of every book it does not mean to change exactly as they were: alignment maps, reading places and bookmarks name them by id (ADR 0026).

```bash
npm run backup -- data/sonder.db data/backups/compare-$(date +%s).db   # or any copy of the database
npx tsx scripts/compare-extractor.ts --db data/sonder.db --before origin/main --expect <edition id>,<edition id> --out artifacts/compare-extractor.json
```

It runs the extractor of the git ref (`--before`, default `origin/main`) and of this checkout over every EPUB edition of the database, each on its own copy of the database, and prints one line per edition: identical, or the first difference (chapter, sentence, id, length, block). The summary gives the count of identical editions and, for each changed one, its sentences and the share of its text they hold, before and after. `--expect` lists the editions that are meant to change; the exit code is 1 when the changed editions are not exactly those, when an edition could not be read on either side (it is listed as failed, never as identical), or when nothing was read. It reads the EPUB files and writes nothing outside a temp folder. On a host whose temp path is long, start it with `node --import tsx` instead of `npx tsx`.

## Live verification

Which checks run where:

| Check | Run by |
| --- | --- |
| `scripts/verify-integrated-reader.mjs` | `scripts/deploy.sh` after every deploy, and by hand |
| `scripts/verify-multi-user.mjs` | `scripts/deploy.sh` after every deploy, and by hand |
| `scripts/verify-playback-workflow.mjs` | by hand |
| `scripts/verify-reading-sync.mjs` | by hand (needs an ebook id and a recording id with a finished map) |
| `scripts/verify-slice-pass.mjs` | `scripts/deploy.sh` with `SONDER_DEPLOY_SLICE_PASS=1` (a slice's final deploy), and by hand |

`SONDER_DEPLOY_LIVE_CHECKS` replaces the deploy's list and `--skip-live-checks` skips it. The slice pass (#794) walks the slice finals' lists at 390 by 844 and 1280 by 800 (Discover, a Book page, the Get sheet, the Library's chips and Shelf, each Settings page, the offline line; Read with Appearance, the sleep timer, Search, a bookmark, Back to narration, a long-press with Undo and the face remembered; an ebook-only book with its slider), under the same write guard and choosers as the reader check, and writes `artifacts/slice-pass-verification.json` and a screenshot per step (`artifacts/slice-pass-<size>-<step>.png`); `SONDER_VERIFY_EBOOK_WORK=<workId>` prefers an ebook-only book. `tests/e2e/slice-pass.spec.ts` runs the same walk against the suite's server. `scripts/verify-multi-user-snapshot.mjs` is not a check: it is the multi-user check's comparison of the administrator's library (`tests/verify-multi-user-snapshot.test.ts`). None of them runs on a CI or build host, and `npm run check` runs none: they need the owner's real books. To try a changed check, run it against a local test server (`SONDER_VERIFY_URL` on loopback, not port 3001), such as `tests/browser-server.ts` after `npm run build` (`PLAYWRIGHT_PORT` sets its port; the multi-user check needs a password, so start that server with `PLAYWRIGHT_AUTH=1 APP_PASSWORD=<any>` and give the check the same `APP_PASSWORD`). Every check names only screens, classes and controls the app has, and none of the removed ones (`tests/live-check-locators.test.mjs`, `scripts/live-check-locators.mjs`). The multi-user check recognises a placeholder by the rule of #483 (an audio edition whose recordings have no track), never by its id (`tests/verify-multi-user-placeholders.test.ts`).

The playback, reader and reading-sync verification scripts share a browser-write guard. Expected progress, bookmark and preference writes are handled locally; unexpected mutations fail the check. Protection remains installed until the browser context closes. Unload beacons and mutating keepalive requests are suppressed in-page because they can bypass browser routing. Counts and error telemetry for suppressed requests may be incomplete while a document is being destroyed.

How the playback and reader checks choose their recording, and the exact rule, is in `README.md` (the paragraph on `verify-playback-workflow.mjs`); the rule lives in `scripts/live-check-recording.mjs` (reader, and the request handling) and `scripts/live-check-playback.mjs` (playback), with tests in `tests/live-check-recording.test.mjs` and `tests/live-check-playback.test.mjs`. When no recording qualifies, the check exits 3 before it opens a page, so no browser write can be sent. Only a listing read successfully with no qualifying candidate, or a map answering 404 or 410, leads there; any other failed request during selection exits 1 and names the request, so a broken endpoint is never reported as skipped. A selected recording that then fails the check is a failure: the check does not try another recording.

The manual reading-sync check takes an ebook id and recording id of the work's chosen pair, and refuses a pair without a finished map with intervals. It opens the work's Reading sync page, checks its title, pair, Ready or Partly ready status, mapped percentage, unsynced passage count and phone-width overflow, then opens Details and goes back. It searches the first, middle and last sections with intervals (which may repeat for a book with fewer than three mapped sections), starts Listen from here with a long-press on each sentence, pauses, pages away and checks that Back to narration shows the sentence at the paused audio position; it reloads the page and checks the pair and status again. It does not use chapter pairings. The JSON report records these checks, each sample's track and recovery result, intercepted writes, and `readerPositionUnchanged`; screenshots and JSON go under `artifacts/`. A selected section without a suitable sentence fails with its section number.

Direct API requests require separate auditing because Playwright browser routing does not intercept `context.request`. The reading-sync script directly posts to `/api/auth/login` (which creates a session) and `/api/alignments/recover` (once per sample). Recovery leases a worker, stages a copy of the sampled audio on that host and writes probe output and potentially acoustic cache data there; staging cleanup is attempted but can fail. It does not change the saved reader/listener position, but it is not a read-only check. Recovery status, score and sentence difference are recorded rather than treated as a pass/fail threshold.

To exercise the entire script with a synthetic pair, first build the client, then run this **manual fixture test on the production machine**, not on a CI or build host:

```bash
npm run build
npx tsx --test tests/manual/verify-reading-sync.fixture.ts
```

The fixture starts its own app on loopback on an ephemeral port other than 3001, uses a temporary database, synthetic EPUB and silent audio, and replaces the alignment pool with an in-process fixture. It invokes the verifier in a temporary working directory with a minimal environment and `SONDER_VERIFY_URL` set to that server. It also tests refusal of production and of a listing without intervals, and compares both saved positions before and after. Temporary reports and screenshots are removed with the fixture directory. `npx tsx --test tests/reading-sync-fixture-contract.test.ts` checks the fixture server without invoking the verifier and may run on a build host.

Use local fixture servers when changing or testing the verification tooling. The live scripts (`verify-integrated-reader`, `verify-playback-workflow`, `verify-multi-user`, `verify-reading-sync`) default to the deployed site but refuse to run against it, before launching a browser or sending a request, unless `SONDER_VERIFY_PRODUCTION=1` is set (`scripts/live-check-target.mjs`, #431). Without the variable they accept only a local test server, loopback (`127.0.0.0/8`, `localhost`, `[::1]`, `0.0.0.0`) on a port other than `3001`; production (any host in `PRODUCTION_HOSTS`, today `sonder.pecori.no`, on any port, or loopback on `3001`) and every other URL are refused. Hosts are compared in lower case and without a trailing dot. A LAN address is already refused as an unknown URL; add it to `PRODUCTION_HOSTS` to have it treated as production by name. `deploy.sh` sets the variable for its live checks; set it yourself only for a deliberate run on production, and point `SONDER_VERIFY_URL` at a local test server otherwise. The multi-user script deliberately creates a temporary account and exercises writes under that account; its separate cleanup contract still applies.

When coordinating through Orca, assign each editing worker a separate checkout. Record the task, worktree, commit, check report and any remaining process handles in the handoff. Stop only processes owned by that run.

When re-merging a branch after its earlier merge was reverted, revert the revert first (`git revert <revert-commit>`); a plain merge brings in only the commits made since. Before restarting the container, grep the build for a marker string of the change to confirm it is present.

## Measure the reader's opening

`scripts/measure-reader-open.mjs` measures what opening Read costs on three real books (ADR 0025, the reader plan #799): the time from opening Read to the first readable text, to the reader showing its place, and to following the narration; the time of a jump to another narrated place; the bytes transferred; and the scripts loaded. It measures a desktop profile (1280 by 800, unthrottled) and a phone profile (Pixel 7 screen and touch, the processor four times slower, 10 Mbit/s down, 2 Mbit/s up, 40 ms each way), each cold (a browser that has never opened the app) and warm (the same browser after a reload), and prints the medians of its runs as a table. The full report goes to `artifacts/reader-open-<time>.json`.

It never runs on production and refuses any target that is not a local test server. It measures a copy, which `scripts/reader-open-copy.sh` starts on the production machine: the deployed image on an online backup of the database, with every background loop paused, no torrent client, no alignment pool, no mail and the media mounted read-only, behind a Caddy that compresses as the production site does. Every write the page sends is also answered in the page and never reaches the copy, so each run opens the books at the same saved places. The owner's reading place, listening place, bookmarks and history cannot move.

```bash
scripts/reader-open-copy.sh start
set -a; . <(grep '^APP_PASSWORD=' /home/jahn/audiobook_streamer/.env); set +a
SONDER_VERIFY_URL=http://127.0.0.1:3106 node scripts/measure-reader-open.mjs --runs 5 \
  --books short=<ebook id>,average=<ebook id>,long=<ebook id>
scripts/reader-open-copy.sh stop
```

`--view prepared` measures the new reading view (the hidden switch set, as `?reader-view=prepared` leaves it); `--mode pages` or `--mode scroll` opens the reader in that reading mode whatever the copy has saved, without writing the copy (the page is answered the saved appearance with that mode in it). Leave both out for the reader and the mode a device gets today.

Without `--books` the script takes the shortest, the middle and the longest text among the books that have an EPUB with a reading sync map and were not listened to in the last 48 hours, and prints the choice in the form `--books` takes. A book named with `--books` that was listened to in the last 48 hours is refused unless `SONDER_VERIFY_ALLOW_RECENT=1`. The books of the baseline and its numbers are in ADR 0025; run the same command on them for a before and after. Run it while no check or build is using the machine: the times are medians, and a loaded machine still moves them.
