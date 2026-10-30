# Worker Spec

Write every worker spec from the rules block and template below, and save it in this repository or under `docs/` so it survives session restarts.

## Rules block

Paste this block at the top of every worker spec:

```markdown
Repository: Sonder, in `/home/jahn/audiobook_streamer`. Your worktree is a checkout of the base branch named in your task. Read `AGENTS.md` in it first, and the `CLAUDE.md` for architecture. Read your issue with `gh issue view <n>`.

Code navigation: run `codegraph init -y` once in your worktree first (about 30 seconds). Then use `codegraph explore "<symbols or a question>"` before grep or reading files. `.codegraph` is git-ignored; never add or commit it.

Rules:
- Do not push, merge or open a PR. Do not run `docker compose`, and do not touch `.env`, `data/` or production media.
- The WSL host is `192.168.1.119`. Work there only under `~/sonder-replication/`, and never touch `~/sonder-replication/issue6-1793194927`. Live verification scripts (`scripts/verify-*.mjs`) never run on the host.
- Verify with unit tests only: `npx tsx --test <file>` and `npm test`. Do not run the browser tests or `npm run check`; the coordinator runs them.
- Make unit tests build every repository, file and directory they need in a temporary directory. `npm run check` runs them in a `git archive` snapshot that has no `.git`, so a test that reads the surrounding checkout passes locally and fails there.
- Commands that take longer than 90 seconds go in the background with output in a log file that you poll, so you can read coordinator messages between polls: `orca orchestration check --terminal <your_handle> --json`.
- Check every command flag, option and environment variable with `--help` or grep before you use it or write it into a file. Do not assume one exists.
- When code must read another command's output (JSON, logs), run the command once and copy a real sample into your test. Do not guess the shape: the first spawn wrapper parsed a receipt field that did not exist.
- Commit on your branch with a concise imperative subject. Claude workers end the message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; cursor workers add no trailer.
- If you hit a usage limit, commit the work so far with a message that says what is unfinished, and say so in your report.

Completion: your report lists every bullet of the issue's Proposal, and next to each the test name or command that shows it works. Say plainly what you could not verify. A bullet with no evidence is not done.
```

## Coordinator verification

Verification steps run by the coordinator before landing:

1. Merge `main`.
2. `tsc` and `npm test`.
3. `npm run build`.
4. Run the worker's specs with a distinct `PLAYWRIGHT_PORT`.
5. Run new or changed e2e specs also with `--repeat-each 2` (tests that reuse a book title break under repeats and combined runs: use a unique title per test).
6. Mutation proofs via `scripts/mutate.mjs`.
7. ONE `ci:deck` at a time read with `scripts/ci-result.sh`, never a rerun to get a pass.
8. Landing with `scripts/orca-land.sh`.

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

## Spawn

Run `scripts/orca-spawn.sh --spec-file <file> --name <worktree> --base <branch> --agent <id> --model <id> [--effort <level>]` to launch a worker. It requires `--model`, runs `scripts/orca-preflight.sh`, starts the worker, and checks the effective model in the receipt.

## Read the inbox

Run `node scripts/orca-check.mjs [--run <run_id>] [--wait [<seconds>]] [--ack <delivery_id>]`. Waits are capped at 100 seconds because the shell tool stops commands at about 120 seconds, and `--wait` also works as a timer.

## Resume after a restart

1. Bind the active run: `orca orchestration run-use --id <run_id>`
2. Read the queue with `node scripts/orca-check.mjs --run <run_id>`.
3. List active and retained workers: `orca orchestration worker-list --run <run_id>`

A restart deletes the session scratchpad and stops background waits, so keep specs in this repository or in `docs/`.

## Usage limits

A worker that hits a Claude usage limit reports `failed`, but may resume after the reset and finish. Judge it by its branch (`git log`, `git status`) and its transcript (`orca orchestration worker-read --dispatch <dispatch_id>`), not by the report.

## Coordinator state

Keep one `artifacts/orca/STATE.md` (gitignored) listing for each in-flight item: issue, worktree, local branch, head sha, Deck status, next action.

Wakeups: the prompt is one line, `Read artifacts/orca/STATE.md and do its next action`, and the coordinator updates the file whenever it schedules one; never paste the run state into the prompt (stale wakeups re-fired after work was done about 12 times this session).

## Review policy

Any change touching keyboard handling, persistence/progress, security or shared schemas gets an independent read-only review before the Deck run, by a different model family than the implementer (reviews found a blocking or high bug in 4 of 5 features this session).

- Reviewer spec template: `docs/agents/spec-templates/review.md`.
- Fix findings with a `docs/agents/spec-templates/fix.md` spec.
- The Deck run runs on the final head only.

## Liveness playbook

When `orca orchestration worker-list` shows projection `stale_status` for more than 30 minutes:
1. Send one status request.
2. If no answer in 20 minutes: run `orca orchestration worker-stop`.
3. Run `bash scripts/orca-preflight.sh --after-stop <worktree>`.
4. Inspect the worktree (uncommitted work is often good).
5. Finish the work yourself or respawn on the same worktree.

## Gotchas

- A completed dispatch's mailbox is closed, so send to `run:<run_id>` or start a new dispatch.
- A worker's local branch can differ from its remote name, so use `orca-spawn.sh --base-worktree`.
- Heartbeats are hidden by `orca-check.mjs` unless `--heartbeats`.
- `pkill -f` and `pgrep -f` match their own shell: kill by PID.
- `gh pr edit` fails on this repo (GraphQL Projects classic deprecation): use `gh api -X PATCH repos/jahnzh/sonder/pulls/<n> -F body=@file` (see `docs/agents/issue-tracker.md`).
