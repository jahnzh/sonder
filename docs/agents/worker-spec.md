# Worker Spec

Write every worker spec from the rules block and template below, and save it in this repository or under `docs/` so it survives session restarts.

## Rules block

Paste this block at the top of every worker spec:

```markdown
Repository: Sonder, in `/home/jahn/audiobook_streamer`. Your worktree is a checkout of the base branch named in your task. Read `AGENTS.md` in it first, and the `CLAUDE.md` for architecture. Read your issue with `gh issue view <n>`.

Code navigation: run `codegraph init -y` once in your worktree first (about 30 seconds). Then use `codegraph explore "<symbols or a question>"` before grep or reading files. `.codegraph` is git-ignored; never add or commit it.
Dependencies: `npm ci` runs in the background in a new worktree (log: `.npm-ci.log`). If `tsc` or a test fails immediately on missing modules, wait for the install to finish or check the log.

Rules:
- Do not push, merge or open a PR. Do not run `docker compose`, and do not touch `.env`, `data/` or production media.
- The WSL host is `192.168.1.119`. Work there only under `~/sonder-replication/`, and never touch `~/sonder-replication/issue6-1793194927`. Live verification scripts (`scripts/verify-*.mjs`) never run on the host.
- Verify with the typecheck and the unit files you touch: `npx tsc --noEmit` and `npx tsx --test <file>`. Run before reporting. Do not run the browser tests, `npm test` in full or `npm run check`: the land check and the nightly run them (#905). A browser test takes at most 30 s and loops at most 100 steps (`tests/browser-test-limits.test.mjs`).
- Make unit tests build every repository, file and directory they need in a temporary directory. `npm run check` runs them in a `git archive` snapshot that has no `.git`, so a test that reads the surrounding checkout passes locally and fails there.
- Commands that take longer than 90 seconds go in the background with output in a log file that you poll, so you can read coordinator messages between polls: `orca orchestration check --terminal <your_handle> --json`.
- Check every command flag, option and environment variable with `--help` or grep before you use it or write it into a file. Do not assume one exists.
- When code must read another command's output (JSON, logs), run the command once and copy a real sample into your test. Do not guess the shape: the first spawn wrapper parsed a receipt field that did not exist.
- Commit on your branch with a concise imperative subject. Claude workers end the message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; cursor workers add no trailer.
- If you hit a usage limit, stop working: commit the work so far with a message that says what is unfinished, and say so in your report. Do not keep retrying against an exhausted bucket.

Completion: your report lists every bullet of the issue's Proposal, and next to each the test name or command that shows it works. Say plainly what you could not verify. A bullet with no evidence is not done.
```

## Coordinator verification

Steps the coordinator runs to land a run's work (#905), without asking the owner:

1. Merge `main` into each branch, then merge the run's branches into `main` (after reverting a merge, revert the revert before re-merging the branch; a plain merge brings in only the commits made since).
2. One land check of the merged tip: `npm run ci:run <sha>` (build, unit suite, browser smoke set in Chromium), read with `scripts/ci-result.sh`. A failure is judged at once: fix it, or, for a test that passes when rerun alone, note it as flaky and land. A check cut off by time with no failure does not hold landing.
3. Land with `scripts/orca-land.sh`, deploy at once with `scripts/deploy-prod.sh <commit>`, and close the issues the run delivered.

The full browser suite runs nightly (`scripts/ci-nightly.mjs`); its failures arrive as issues and are fixed forward. Ask the owner only for an account or a product choice he would notice.

## Template

Fill in this skeleton directly below the rules block:

```markdown
## Model choice

- Agent: <claude | cursor | antigravity>
- Model: <model_id>
- Effort: <effort>
- Why: <task complexity and provider quota balance>

## Task

- Issue: #<n>
- Branch: `<branch_name>`
- Base branch: `<base_branch>`

## Proposal

- <Proposal bullet 1 copied from the issue>
- <Proposal bullet 2 copied from the issue>

## Constraints

- <Constraint copied from the issue or task context>

## Done when

Your report lists every bullet of the Proposal, and next to each the test name or command that shows it works; say plainly what you could not verify; a bullet with no evidence is not done.
```

Specialized templates: see [docs/agents/spec-templates/](spec-templates/) for feature (`feature.md`), review (`review.md`), and fix (`fix.md`) specs.

## Plan a ready wave

When several tasks are ready together, plan them as a wave before spawning:

```bash
node scripts/orca-plan.mjs --wave <wave.json>
```

The command takes a fresh usage reading, assesses each ready task through `scripts/orca-recommend.mjs`, then balances dependencies, concurrency, scarce capable combinations and shared allowances. It prints JSON and never starts a worker. See `docs/agents/wave-planner.md` for the wave file shape, statuses (`proposed`, `needs-decision`, `delay`, `deferred`, `blocked`) and capacity notes. Re-run it when workers finish or usage changes. Pass each accepted `launch.args` to `scripts/orca-spawn.sh`; preflight and receipt checks are unchanged. Worker history is not an input.

## Recommend a worker

Before a spawn, ask for a recommendation for the ready task:

```bash
node scripts/orca-recommend.mjs --task <n> --summary "<one shareable paragraph>" [--kind <kind>] [--files <n>] --record <spec-file>
```

The command reads the Jev key from `TYPESAFE_API_KEY` in the environment. Keep the key out of the repository, command lines and worker specs. The command prints JSON and never starts a worker. Pass its `launch.args` to `scripts/orca-spawn.sh`. Run `--help` for every option.

- `--summary` (at most 600 characters), `--kind` and `--files` are all that leaves the machine. Write the summary to be shared: no transcripts, secrets or private text. TypeSafe's Jev answers three narrow questions; the command combines them with the Capability column of `docs/agents/models.md`. It recommends the smallest suitable model and lists the other suitable choices under `alternatives` and the unsuitable ones with their reasons under `rejected`.
- `assessment.jev` gives the Jev version that answered and its uncertainty (`reasoningScore`, `reasoningConfidence`, `reasoningProbabilities`, `enoughInformation`, `wideChange`). One reasoning level must hold probability `>= 0.7` with `confidence >= 0.5` and `enoughInformation > 0.3` (moderate work also needs `wideChange <= 0.3` or `>= 0.7`), so split distributions are treated as `inconclusive`. The thresholds are TypeSafe's starting points, checked on a few live tasks and not tuned; the model is pinned so an alias cannot move them.
- `usage` is the chosen worker's usage and `usageByAgent` every collected agent's. The command takes a fresh reading for each collected agent in the baseline (Claude, Codex, Cursor, Antigravity) first. Only `fresh` and `low` confirm capacity, `exhausted` candidates move to `rejected`, and unknown is not available. For a single task, equivalent alternatives stay in table order; for a ready wave, use `scripts/orca-plan.mjs` to balance shared capacity across tasks. See `docs/agents/usage-collector.md`, `docs/agents/wave-planner.md` and `docs/agents/dispatch-evaluation.md`.
- Exit 3 means Jev was `unavailable`, `invalid` or `inconclusive`. Rerun with `--judgment <mechanical|standard|reasoning-heavy> --judgment-reason "<why>"`; the fallback is recorded in `fallback` and in the spec.
- To choose differently, add `--override <agent>/<model>[/<effort>] --override-reason "<why>"`. The recommendation and the reason are both recorded. An override below the assessed requirement is recorded with a warning; a model or effort missing from the baseline is refused, so add and verify its row first. An override does not replace the assessment.
- `--record` fills the spec's `## Model choice` section. Without it, write the choice and its reason there yourself.

The spawn checks do not change: the model stays explicit, the preflight runs, and the effective model in the receipt is compared with the requested one. A non-zero exit from `orca-spawn.sh` is not evidence that no worker started: the model check fails after the launch, and `outcome_unknown` exits 1. Read the receipt it prints and run `orca orchestration worker-show --dispatch <dispatch_id>` before any retry, following the recovery commands in the receipt. Never run the spawn again to find out.

## Spawn

Run `scripts/orca-spawn.sh --spec-file <file> --name <worktree> (--base <branch> | --base-worktree <name>) --agent <id> --model <id> [--effort <level>] [--fix-of <dispatch>] [--review-of <dispatch>]` to launch a worker. It requires `--model` and exactly one of `--base` and `--base-worktree`, runs `scripts/orca-preflight.sh`, starts the worker, and checks the effective model in the receipt. `--base-worktree <name>` uses the branch checked out in that worktree, for a worker whose local branch name differs from the remote one (`jahnzh/fix-79` against `fix/79-offline-stall`). After the launch the script prints `branch: <name>`, the new worktree's real local branch, for push and cleanup. `--fix-of` / `--review-of` link the new dispatch to an earlier one after capture. The preflight also fails when free space on `/` (or on the workspaces filesystem) is below `ORCA_MIN_FREE_GB` (default 15) and names what to clean.

## Record the outcome

Lifecycle capture is automatic: `scripts/orca-spawn.sh` captures after a successful launch, and `scripts/orca-check.mjs` captures again for each `worker_done` that names a `dispatchId` (before `worker-release`; the payload may be a JSON string, as the orca CLI sends structured payloads). A successful automatic capture or record-review prints a `history:` line on stderr, so a silent skip cannot pass unnoticed. Spawn `--fix-of` / `--review-of` link the new dispatch after capture. Reviewers must put `Findings: blocking=N high=N medium=N low=N` on its own line in the `worker_done` body so `orca-check` can `record-review` on the reviewed dispatch (via the spawn `--review-of` link); a reviewer's `worker_done` without that line, or without a `review_of` link, records nothing and prints one reminder (implementer `worker_done`s never remind). CI scripts record a check when `SONDER_CI_DISPATCH` is set. Failures are warnings only and do not break the dispatch or the CI exit code. Still run a manual `node scripts/orca-history.mjs capture --dispatch <dispatch_id> --recommendation <recommend output>` to attach the recommendation. Unavailable information is stored as unknown. See `docs/agents/worker-history.md`.

## Read the inbox

Run `node scripts/orca-check.mjs [--run <run_id>] [--wait [<seconds>]] [--ack <delivery_id>] [--heartbeats]`. Waits are capped at 100 seconds because the shell tool stops commands at about 120 seconds, and `--wait` also works as a timer. A delivery with only heartbeats is acknowledged and the wait goes on; if only heartbeats arrive before the wait ends, the output is one line `count=0 delivery=null timedOut=true heartbeats=<n>`. A delivery that also holds another message is printed without its heartbeats and left for you to ack. `--heartbeats` prints every delivery as Orca returns it and acks nothing.

## Resume after a restart

1. Bind the active run: `orca orchestration run-use --id <run_id>`
2. Read the queue with `node scripts/orca-check.mjs --run <run_id>`.
3. List active and retained workers: `orca orchestration worker-list --run <run_id>`

4. Restart the helpers on the same run id: `bash scripts/orca/watch-inbox.sh <run_id>`, `nohup bash scripts/orca/watchdog.sh <run_id> &` and `bash scripts/orca/check-workers.sh <run_id>`. They have no default run and exit 2 with a usage line without the argument.

A restart deletes the session scratchpad and stops background waits, so keep specs in this repository or in `docs/`.

## Usage limits

A worker that hits a Claude usage limit reports `failed`, but may resume after the reset and finish. Judge it by its branch (`git log`, `git status`) and its transcript (`orca orchestration worker-read --dispatch <dispatch_id>`), not by the report.

When a worker dies on a quota limit with a complete-but-uncommitted change set, recover it before the worktree is reused: inspect the branch (`git log`, `git status`, `git diff`), verify the work per the Coordinator verification checklist, and commit it on the worker's branch before any further dispatch on that worktree.

## Coordinator state

Keep one `artifacts/orca/STATE.md` (gitignored) listing for each in-flight item: issue, worktree, local branch, head sha, Deck status, next action.

Record state and decision notes using `scripts/orca/note.sh state "<text>"` and `scripts/orca/note.sh decision "<text>"` (or the wrapper `artifacts/orca/note.sh`). Notes are stamped with the real UTC time (`date -u`). The script rotates `artifacts/orca/STATE.md`: keeps the last 24 h plus a pinned "current" section (<= 60 lines), moving older text to `artifacts/orca/state-archive/YYYY-MM-DD.md`. Rotation is idempotent and never drops text. Clock overrides for testing are supported via `SONDER_NOW` or `DATE_CMD`.

Wakeups: the prompt is one line, `Read artifacts/orca/STATE.md and do its next action`, and the coordinator updates the file whenever it schedules one; never paste the run state into the prompt (stale wakeups re-fired after work was done about 12 times this session).

Active deploy-or-land goals: either block on `node scripts/orca-check.mjs --wait` (or a background wait job) until the next actionable result, or post a progress line and continue immediately — never treat a status question as a stop. Start every committed check with `npm run ci:run` (central resource admission and FIFO queue across WSL and lisa; Deck only as fallback); a push starts none (#905). Do not fire parallel `ci:ssh` / `ci:deck` yourself — those bypass the dispatcher. When the dispatcher admits more than one check on the same host it assigns each a distinct `SONDER_CI_LOOPBACK_PORT` (from 4400) so Playwright readiness probes do not collide. An orchestrator that finishes a task starts the next one at once; a coordinator reads its orchestrator's terminal at least every 10 minutes (an idle agent sends no message).

## Worker prompt delivery (send-agent)

`scripts/orca/send-agent.sh <terminal> --queue "<message>"` (or `--interrupt`) delivers a prompt to a worker and confirms delivery by re-reading the screen for up to 10 seconds:
- `result: delivered`: the prompt was detected and the worker is busy (turn started).
- `result: queued`: the prompt was detected in the follow-ups queue.
- `result: typed, no turn started (Enter may have been swallowed)`: the prompt was detected on screen but no turn started within 10 seconds.
- `result: not found`: neither was detected within 10 seconds.

## Worker screen monitoring

`bash scripts/orca/check-workers.sh <run_id>` (the run id is required; without it the script prints `usage: check-workers.sh <run_id>` and exits 2) inspects worker terminal screens to classify their state as `busy`, `idle`, or `exited`. Busy markers recognised across agent engines:
- **Cursor**: Braille spinner glyphs (`[\u2800-\u28FF]`) followed by a capitalized `-ing` word (`Running`, `Waiting`, `Thinking`, etc.).
- **Codex**: `Working (\d` or `• Working (` lines.
- **Antigravity**: Braille spinner glyph lines (`[\u2800-\u28FF]`), `Running command`, `Thought for`, `ManageTask`.


## Review policy

Any change touching keyboard handling, persistence/progress, security or shared schemas gets an independent read-only review before the Deck run, by a different model family than the implementer (reviews found a blocking or high bug in 4 of 5 features this session).

- Reviewer spec template: `docs/agents/spec-templates/review.md`.
- Fix findings with a `docs/agents/spec-templates/fix.md` spec.
- Spawn the reviewer with `scripts/orca-spawn.sh … --review-of <implementer-dispatch>` and a fix worker with `--fix-of <reviewed-dispatch>`.
- The reviewer's `worker_done` body must include exactly one counts line so history can record it:

```text
Findings: blocking=N high=N medium=N low=N
```

- The Deck run runs on the final head only.

## Liveness playbook

While a deploy-or-land goal is active, follow Active deploy-or-land goals under Coordinator state — do not idle on status dumps or background CI polls.

When `orca orchestration check --wait` returns two consecutive empty waits and the active workers' worktrees are unchanged (`git rev-parse HEAD` and `git status --porcelain`), read each worker terminal tail (`orca terminal read --terminal <handle>`). `node scripts/orca-check.mjs --run <run_id> --wait … --workers <worker-list.json> --liveness-state <file>` tracks that and prints `liveness: usage-limit …` on stderr when a tail matches a known limit prompt.

When `orca orchestration worker-list` shows projection `stale_status` for more than 30 minutes:
1. Send one status request.
2. If no answer in 20 minutes: run `orca orchestration worker-stop --dispatch <id>`.
3. Run `bash scripts/orca-preflight.sh --after-stop <worktree>`.
4. Inspect the worktree (uncommitted work is often good).
5. Finish the work yourself or respawn on the same worktree.

## Reap after a stop

`orca orchestration worker-stop` on a settled dispatch reaps nothing (`processAction: "none"`): rcfile shells, agent CLIs and MCP servers linger in the worktree and fail the next spawn's preflight. Run `bash scripts/orca-reap.sh <worktree>` after every stop, before the next spawn. It reads the PIDs from `orca-preflight.sh --after-stop` (cwd-based, so it finds processes whose cmdline does not name the worktree), sends SIGTERM, escalates to SIGKILL after ~5 s for what survives, and exits 0 only when preflight reports the worktree clean.

## Gotchas

- A completed dispatch's mailbox is closed, so send to `run:<run_id>` or start a new dispatch.
- A worker's local branch can differ from its remote name, so use `orca-spawn.sh --base-worktree`.
- Heartbeats are hidden by `orca-check.mjs` unless `--heartbeats`.
- `orca orchestration worker-show` takes no `--run` flag; its valid flags are `--dispatch`, `--environment`, `--json` and `--pairing-code`.
- `pkill -f` and `pgrep -f` match their own shell: kill by PID.
- `gh pr edit` fails on this repo: see `docs/agents/issue-tracker.md`.
- Dated plan files record context for that run, not durable policy; a rule lifts when the owner asks for the thing it forbids.
