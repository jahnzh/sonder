# Repository Guidelines

## Project Structure

Sonder is a React/TypeScript PWA backed by Fastify and SQLite. Client code is in `src/`, API and database code in `server/`, and the Python alignment service in `worker/`. Assets are in `public/`, scripts in `scripts/`, unit tests in `tests/`, and browser tests in `tests/e2e/`. Read the relevant `README.md` section before changing a workflow.

## Code navigation

Use CodeGraph for every question about where code is or what a change affects. Before grep, find or reading files, run `codegraph explore "<symbol names or a question>"`: it prints the relevant source and the call paths between the symbols. Use `codegraph node <name or file>` for one symbol or file, and `codegraph impact <symbol>` before changing shared code. Run `codegraph sync` after editing many files.

Each worktree has its own index in `.codegraph/`, which git ignores, so a new worktree has none. Run `codegraph init -y` once in it (about 30 seconds) before starting work.

## Main flow

Every change moves through `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` → `/code-review` → `/retro`. The stage skills are user-invoked slash commands; a user prompt or instruction that names a stage counts as that invocation. When a stage's artifact is missing, stop and name the command for the user to run.

| Stage | Artifact in this repo | Next stage starts when |
| --- | --- | --- |
| `/grill-with-docs` | Terms in `GLOSSARY.md`; hard-to-reverse decisions as ADRs in `docs/adr/` | The plan is settled |
| `/to-spec` | The spec, published as a GitHub issue | The spec issue exists |
| `/to-tickets` | Tracer-bullet tickets as GitHub issues with native blocking links, labelled `needs-triage` and listed on roadmap #11 | `/triage` has set a ticket to `ready-for-agent` |
| `/implement` | One worktree and branch per ticket, built by a worker chosen under "Spawning subagents" | The worker's typecheck and the unit files it touched pass |
| `/code-review` | Standards and spec findings for the branch | Every finding is fixed or answered |
| `/retro` | Improvements filed as `needs-triage` issues | — |

- A change small enough to build at once goes straight to `/implement`. It still has an issue and still gets `/code-review`.
- The pipeline (#905): commit (typecheck), push (`npm run build`), land on main after one land check of the merged tip (`npm run ci:run <sha>`: build, unit suite, browser smoke set in Chromium, ≤ 10 min), deploy at once (`scripts/deploy-prod.sh`), and a nightly full check that never blocks. A failing test is rerun alone once; one that passes alone is flaky, is noted, and does not hold landing. A check cut off by time with no failure does not hold landing either.
- The coordinator lands a run's work after the land check, deploys at once and closes the issues it delivers, without asking the owner. It asks him only for an account or a product choice he would notice.
- Merge a branch only after every `/code-review` finding is fixed or answered. Fix a finding that can happen in the setup under "Style and Testing"; answer any other in one line in the PR with why it cannot happen there, without another fix-and-review round. The standards axis reads that section.
- An effort too large for one session starts with `/wayfinder`.
- A PR closes its issue only when it does every bullet of the issue's Proposal. Otherwise write `Refs #N`, keep the issue open and say what remains.
- Look at every running CI check yourself: a hung check never reports its own end. See `docs/agents/coordinator-checks.md`.

## Development and Checks

Use Node 24 and install dependencies with `npm ci`.

- `npm run dev` starts the API on port 3001 and Vite on 5173. Stop the production container first if it occupies port 3001.
- `npm run build` typechecks, builds the client and generates the service worker.
- `npm test` runs Node tests through `tsx`; `npm run test:browser` runs Playwright. Build first: browser tests serve `dist/`.
- `npm run check -- --ref <commit>` runs install, build, the unit suite and the browser smoke set (`--level full`: the whole browser suite) in an isolated snapshot of a committed revision. See `docs/LOCAL_CHECKS.md` for reports and options.
- `scripts/deploy-prod.sh <commit>` checks out the revision in the production bare work tree and runs `scripts/deploy.sh` in a subshell (no leaked `GIT_*` env). `scripts/deploy.sh <commit>` deploys a committed revision to the production container (backup, rollback tag, build, markers, health, live checks). See `docs/LOCAL_CHECKS.md` (Production deployment).

## CI over SSH

`npm run ci:run <sha>` (`scripts/ci-run.sh`) is the only entry point for committed checks (issue #365). It joins a central FIFO queue, probes WSL and lisa over SSH, and admits the check on the host with the most headroom while that host's admission rule holds (`scripts/ci-hosts.json`). The Deck is a fallback when neither WSL nor lisa has room (or when listed explicitly in `SONDER_CI_HOSTS`). `npm run ci:ssh` / `npm run ci:deck` stay as the low-level runners the dispatcher calls — use them only when debugging those scripts. Check host access with `ssh -o BatchMode=yes -o ConnectTimeout=5 192.168.1.119 true`. Status: `npm run ci:run -- --status`.

A push starts no check (#905). `npm run ci:run <sha>` runs at level `land` by default: install, build, the unit suite and the browser tests tagged `@smoke` in Chromium, held to the bar. `npm run ci:run -- --level full <sha>` runs the whole browser suite in every project and is held to no bar; the nightly timer (`scripts/install-nightly.sh`, `scripts/ci-nightly.mjs`) runs it on `origin/main` once a night, writes `artifacts/ci/nightly/latest.json` and files one `needs-triage` issue per failing test it has not filed before. `npm run ci:push` pushes and starts a land check, when wanted.

Use `npm run ci:deck <sha>` only when debugging `scripts/ci-deck.sh` itself — it refuses a second concurrent run and posts `ci/deck`. Read `docs/agents/ci-host.md` and `docs/agents/ci-deck.md` first.

- Send a Git bundle of the committed revision to a unique temporary checkout on the host. Install dependencies and run `nice -n 10 npm run check -- --ref <commit>` there, at the level asked for.
- Keep browsers headless and muted. Check that the host's Playwright browsers match the lockfile before the first run.
- Retrieve the report and logs, post the commit status, then clean up only that run's files and processes.
- Live verification scripts (`verify-*.mjs`) never run on the host. They target production and stay on the production machine.

If SSH is unreachable, run the same committed revision locally with `npm run check -- --ref <commit>`. Record the fallback, host, commit and result in the handoff. A test failure on the host is a failure: do not rerun locally to get a pass, and do not treat it as connectivity fallback. The runners' own fallback (`ci-ssh.sh`, `ci-deck.sh`) runs that check in the run's report directory and records `mode=local_fallback`; a local check that ends before it starts a stage (no `stage-started` file in the report directory) judged nothing and is recorded `result=local_setup_failed`, which does not block the commit (#887).

## Style and Testing

Follow nearby TypeScript and React conventions: two-space indentation, `PascalCase` components, `camelCase` functions, and descriptive kebab-case module names. There is no configured linter; `npm run build` performs typechecking. Name unit tests `*.test.ts` or `*.test.mjs` and Playwright tests `*.spec.ts`. Add focused regression coverage for behavior changes; no coverage threshold is configured.

The setup that severity is judged against: one owner using the app on a phone and a desktop, two alignment hosts with a known layout (WSL with a GPU, lisa on CPU; `docs/CTC_WORKER_POOL.md`), and full-length audiobooks from his own library. A reviewer rates a finding by whether it can happen there.

- Workers run the typecheck and the unit files they touch, no browser tests. A browser spec a worker writes or changes runs in the land check (if tagged `@smoke`) and the nightly. `scripts/stress-spec.sh` stays a tool for chasing a flaky test, never a step before landing.
- A browser test takes at most 30 seconds (Playwright's default timeout) and a spec file at most about 2 minutes of browser time. A loop over pages, parts or turns uses a fixed small sample (open the book next to what it checks), at most 100 steps, never "until the end"; a long soak runs only behind an opt-in flag (`SONDER_LONG_READS=1`), outside the check. `tests/browser-test-limits.test.mjs` enforces this. Report a new or changed spec's run time with it.
- A test that needs a temp folder takes it from `tempDir()` in `tests/temp-dir.ts`, which removes it; `tests/temp-leftovers.test.mjs` guards this.

## Changes and Safety

Use concise, imperative commit subjects; history also uses scopes such as `fix(ci):` and issue references. PR descriptions should explain the change, link the issue, list checks and include screenshots for visual changes. Keep `.env`, `data/` and `artifacts/` private. Database schema changes must remain additive and update both `server/db.ts` and `server/schema.ts`. Read `docs/LOCAL_CHECKS.md` before backups or live verification. `git commit` runs the pre-commit hook: a typecheck, unless the commit stages only `docs/` or markdown files. `git push` runs the pre-push hook: `npm run build` (under a minute) unless the push carries only `docs/` or markdown files. It starts no check and never runs the test suites (#905). Verify the push landed with `git status -sb`; `SONDER_SKIP_PREPUSH=1 git push` skips the hook once.

## Agent skills

Agent skills setup follows the main flow from https://www.aihero.dev/skills-setup-matt-pocock-skills. It was run once for this repo with `/setup-matt-pocock-skills`; re-run it only to switch trackers or start over. Routine changes are made by editing the files below by hand.

- **Issue tracker**: GitHub issues on `jahnzh/sonder`, via `gh`. See `docs/agents/issue-tracker.md`. Pinned issue #11 is the roadmap.
- **Triage labels**: the five canonical roles map one-to-one to the labels on the repo (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.
- **Domain docs**: single-context layout, `GLOSSARY.md` plus `docs/adr/` (created lazily). See `docs/agents/domain.md`.

## Agent references

- Ask for a worker recommendation with `scripts/orca-recommend.mjs` (see "Recommend a worker" in `docs/agents/worker-spec.md`). It never starts a worker.
- Plan a ready wave together with `scripts/orca-plan.mjs`; read `docs/agents/wave-planner.md` first. It never starts a worker.
- Inspect or reset learned recommendation adjustments with `node scripts/orca-learn.mjs`; read `docs/agents/learned-adjustments.md` first. It never starts a worker and never deletes raw history.
- Spawn a worker with `scripts/orca-spawn.sh`, and write its spec from `docs/agents/worker-spec.md`.
- Coordinator state and spec templates: see `docs/agents/worker-spec.md`.
- Read the Orca inbox with `node scripts/orca-check.mjs`; after a session restart follow "Resume after a restart" in `docs/agents/worker-spec.md`.
- Before judging an agent or model capacity, read the **Quota buckets** section in `docs/agents/models.md`: quota is per model bucket, never one number per agent.
- Before adding a model to `docs/agents/models.md` or running `orca-models`, read `docs/agents/model-discovery.md`.
- Read `docs/agents/routing-policy.md` before changing dispatch rules.
- Before reading or interpreting Claude subscription usage (`node scripts/claude-usage.mjs`), read `docs/agents/claude-usage.md`.
- Before running CI on the Steam Deck, read `docs/agents/ci-deck.md`.
- Before running `npm run test:android` or the Android emulator on the Steam Deck, read `docs/agents/emulator.md`.
- Before running CI on the WSL host, read `docs/agents/ci-host.md`; run `npm run check -- --known-failures tests/known-failures.wsl-host.json` so a run with only the known failures passes.
- After a worker finishes, keep its outcome and transcript with `node scripts/orca-history.mjs`; read `docs/agents/worker-history.md` first.
- Before reading or interpreting Antigravity quota (`node scripts/antigravity-usage.mjs`), read `docs/agents/antigravity-usage.md`.
- Before reading or interpreting Cursor usage (`node scripts/cursor-usage.mjs`), read `docs/agents/cursor-usage.md`.
- Before reading or interpreting Codex usage (`node scripts/codex-usage.mjs`), read `docs/agents/codex-usage.md`.
- Before installing, checking or recovering the usage collector (`scripts/orca-usage.mjs`), or judging `usage` in a recommendation, read `docs/agents/usage-collector.md`.
- Before reading or writing a multi-provider dispatch evaluation (`docs/agents/dispatch-evaluation.md`, `scripts/orca-dispatch-eval.mjs`), read that doc first. It never starts workers or sends history to Jev.
- Before coordinating workers (a heartbeat, a worker's report, a check, a landing, a deploy, host work, stopping a run, closing an issue, reporting to the owner), read `docs/agents/coordinator-checks.md`.
- Install the git hooks once per clone with `scripts/install-hooks.sh`. What the pre-push hook runs is described under "Changes and Safety".
- Update the alignment workers on the pool hosts with `scripts/update-ctc-workers.sh <commit>`; `scripts/install-ctc-workers.sh` is for a new host.

## Coordinator shell helpers (Orca)

Tracked under `scripts/orca/` (commit `send-agent.sh`, `check-workers.sh`, `watch-inbox.sh`, `watchdog.sh`, `tick.sh`, `note.sh`, `heartbeat.sh`, `worker-done.sh`); `check-workers.sh`, `watch-inbox.sh` and `watchdog.sh` take the run id as their first argument (`bash scripts/orca/check-workers.sh <run_id>`) and print a usage line and exit 2 without it: there is no default run. Thin wrappers at `artifacts/orca/*.sh` exec those paths so existing coordinator commands keep working. `watch-inbox.sh` uses `${XDG_RUNTIME_DIR:-/tmp}/sonder-watch-inbox-<run>.lock` (exclusive `flock`), `.pid` (holder PID for a second instance, exiting 0 with 'already running' if live), and `.log` (append-only record of consumed messages).

## Spawning subagents

Before spawning any subagent, decide the intelligence level the task needs and choose the agent and model to match. Do not default every worker to the same model.

- Give reasoning-heavy work (reproducing timing or rendering bugs, metric and analysis work, cross-file refactors) the most capable model available.
- Give mechanical work (a scripted change with a clear spec, a small UI edit) a smaller model.
- Set the model explicitly with `--model` and `--effort` rather than letting each agent use its default.
- Take model ids from the agent's own listing: `agent --list-models` for cursor, and the ids a launch receipt reports for claude and antigravity. Confirm the effective model in the receipt after launch.
- Run `codegraph init -y` in each worker's worktree before it starts, and tell the worker in its spec to use CodeGraph for code navigation.
- See `docs/agents/models.md` for verified model ids, supported effort values and usage notes.

Also consider usage limits when dividing work. Spread tasks across agents so no single provider's quota runs out mid-wave, and keep the number of concurrent workers modest. Record the choice and its reason in the spec or the handoff.

Before `orca orchestration worker-start`, run `scripts/orca-preflight.sh <base-branch> <worktree-path> <doc>...`; after `worker-stop`, run it with `--after-stop <worktree-path>` to list leftover processes.
