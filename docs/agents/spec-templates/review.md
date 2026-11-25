# Review Worker Spec

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

## Model choice

- Agent: <claude | cursor | antigravity>
- Model: <model_id>
- Effort: <effort>
- Why: <independent review by different model family than implementer>

## Task

- Issue: #<n>
- Branch: `<branch_name>`
- Base branch: `<base_branch>`
- Report: <absolute path in the main checkout, e.g. /home/jahn/audiobook_streamer/artifacts/orca/review-<n>-round1.md — the coordinator fills in the real path>

## Scope and focus

Read-only: must not edit or commit any files.

Numbered list of what to look hardest at:
1. <Focus area 1: keyboard handling, persistence/progress, security, or shared schemas>
2. <Focus area 2: edge cases, race conditions, or state invalidation>
3. <Focus area 3: contract / API boundary changes>

Standing item, checked in addition to the numbered focus items:
- E2E contract: for each behaviour the diff changes, name the existing `tests/e2e` specs that pin the old behaviour and state whether each still holds. A diff that silently changes behaviour an e2e spec pins is a BLOCKING finding.

## Findings format

Report all findings categorized by severity:
- `BLOCKING`: Regressions, data loss, security vulnerabilities, broken core workflows.
- `HIGH`: Flaky behavior, state desync, unhandled error cases in main paths.
- `MEDIUM`: Code smells, performance bottlenecks, incomplete edge case handling.
- `LOW`: Stylistic nits, minor documentation discrepancies.

End the `worker_done` body with this exact counts line so `scripts/orca-check.mjs` can record the review automatically (N are non-negative integers):

```text
Findings: blocking=N high=N medium=N low=N
```

## Constraints

- Read-only: must not edit or commit.
- Send `worker_done` within 30 minutes even if incomplete.

## Done when

Send `worker_done` within 30 minutes even if incomplete. Your report lists findings categorized by severity (BLOCKING/HIGH/MEDIUM/LOW), includes the `Findings: blocking=N high=N medium=N low=N` line, and addresses each numbered focus item and the standing E2E contract item. Write the full report to the Report path and name that path in `worker_done`.
