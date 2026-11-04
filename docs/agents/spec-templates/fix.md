# Fix Worker Spec

Repository: Sonder, in `/home/jahn/audiobook_streamer`. Your worktree is a checkout of the base branch named in your task. Read `AGENTS.md` in it first, and the `CLAUDE.md` for architecture. Read your issue with `gh issue view <n>`.

Code navigation: run `codegraph init -y` once in your worktree first (about 30 seconds). Then use `codegraph explore "<symbols or a question>"` before grep or reading files. `.codegraph` is git-ignored; never add or commit it.
Dependencies: `npm ci` runs in the background in a new worktree (log: `.npm-ci.log`). If `tsc` or a test fails immediately on missing modules, wait for the install to finish or check the log.

Rules:
- Do not push, merge or open a PR. Do not run `docker compose`, and do not touch `.env`, `data/` or production media.
- The WSL host is `192.168.1.119`. Work there only under `~/sonder-replication/`, and never touch `~/sonder-replication/issue6-1793194927`. Live verification scripts (`scripts/verify-*.mjs`) never run on the host.
- Verify with typecheck and unit tests: `npx tsc --noEmit`, `npx tsx --test <file>` and `npm test`. Run before reporting. Do not run the browser tests or `npm run check`; the coordinator runs them.
- Make unit tests build every repository, file and directory they need in a temporary directory. `npm run check` runs them in a `git archive` snapshot that has no `.git`, so a test that reads the surrounding checkout passes locally and fails there.
- Commands that take longer than 90 seconds go in the background with output in a log file that you poll, so you can read coordinator messages between polls: `orca orchestration check --terminal <your_handle> --json`.
- Check every command flag, option and environment variable with `--help` or grep before you use it or write it into a file. Do not assume one exists.
- When code must read another command's output (JSON, logs), run the command once and copy a real sample into your test. Do not guess the shape: the first spawn wrapper parsed a receipt field that did not exist.
- Commit on your branch with a concise imperative subject. Claude workers end the message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; cursor workers add no trailer.
- If you hit a usage limit, stop working: commit the work so far with a message that says what is unfinished, and say so in your report. Do not keep retrying against an exhausted bucket.

Completion: your report lists every bullet of the issue's Proposal, and next to each the test name or command that shows it works. Say plainly what you could not verify. A bullet with no evidence is not done.

## Model choice

- Agent: <claude | cursor | antigravity>
- Model: <model_id>
- Effort: <effort>
- Why: <targeted fixes with regression tests and mutation proofs>

## Task

- Issue: #<n>
- Branch: `<branch_name>`
- Base branch: `<base_branch>`

## Findings to fix

Verify each claim against the code before fixing. Skip LOW items unless trivial.

1. <Finding 1 copied from review or triage>
2. <Finding 2 copied from review or triage>

## Constraints

- Verify each claim against the code before fixing.
- Skip LOW items unless trivial.
- Each behavioural fix needs a test that fails on the base code and passes after.
- Print mutation proofs using `scripts/mutate.mjs`.

## Done when

Your report lists each finding addressed, indicating whether it was fixed, verified as a false positive, or skipped (LOW items). For each behavioural fix, include the test name that fails on the base code and passes after, along with the mutation proof printed by `scripts/mutate.mjs`.
