# Feature Worker Spec

Repository: Sonder, in `/home/jahn/audiobook_streamer`. Your worktree is a checkout of the base branch named in your task. Read `AGENTS.md` in it first, and the `CLAUDE.md` for architecture. Read your issue with `gh issue view <n>`.

Code navigation: run `codegraph init -y` once in your worktree first (about 30 seconds). Then use `codegraph explore "<symbols or a question>"` before grep or reading files. `.codegraph` is git-ignored; never add or commit it.

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

- Agent: codex
- Model: gpt-6.1-terra
- Effort: max
- Why: Jev assessed reasoning-heavy; the only reasoning-heavy candidate (antigravity/claude-opus-5-5-high) is exhausted until 2026-11-07, so this is an override below the assessed requirement, recorded with that reason. The spec is fully specified (behaviour-preserving), and the change gets an independent review by a different model family.

## Task

- Issue: #139
- Branch: `jahnzh/139-reader-alignment-lifecycle`
- Base branch: `main`

Read `gh issue view 139` and its parent spec `gh issue view 134` fully. Use the `tdd` skill at the lifecycle module's interface. Typecheck and run single test files often; run the full `npm test` once at the end. Do not touch playback warming (that is #140).

## Proposal

- A lifecycle module owns the reader's map acquisition, cache identity, matching and stale classification, persistence, removal, validation history and existing fallback behaviour; the mounted reader keeps one instance across recording changes.
- Initial fingerprint-compatible cached display, summary matching, once-per-session/job-run server confirmation and fresh-map persistence behave as before.
- Changed job/source fingerprints, older-but-not-stale entry, missing ebook fingerprint, absent jobs and zero intervals keep the #134 behaviour; no-job/zero-interval display clears without deleting the stored entry.
- Map 404/410, other map errors (incl. current authorization-error fallback), offline/network/5xx summary failures and other summary errors keep their cache and display outcomes; server private no-store map contract unchanged.
- A manual sentence-timing correction persists and displays the returned map before the existing refresh; validation history and storage-failure behaviour unchanged.
- Behaviour-focused tests exercise the module interface with local storage and owned HTTP test facilities; existing integrated reader and server map-cache tests stay green. Cover current selection/cancellation and overlapping requests without asserting stronger guarantees.

## Constraints

- No changes to polling schedules, database schema, endpoint contracts, user-facing copy or alignment generation; no intentional changes to fallback, cancellation races or request ordering. Playback warming stays on its existing path.
- Any `src/` file the server imports must stay out of this change (the production image copies only a few).

## Done when

Your report lists every bullet of the Proposal, next to each the test name or command that shows it works, and mutation proofs printed by `scripts/mutate.mjs` for behavioural changes; say plainly what you could not verify; a bullet with no evidence is not done.
