Repository: Sonder. Your worktree (created by the coordinator from the tip of `jahnzh/issue-168-resend-approval`, which already contains the #167 account requests and #168 Resend/approval code) is on branch `jahnzh/issue-169-invite-activation`. Read `AGENTS.md` in it first, and the `CLAUDE.md` for architecture. Read your issue with `gh issue view 169` — the last comment is the authoritative Agent Brief.

This is the `/implement` stage for ticket #169. Load and follow the `implement` skill: implement the ticket from the issue, call the `tdd` skill at the pre-agreed seams where possible, run typechecking regularly and single test files regularly, and run the full test suite once at the end. Commit your work to the current branch.

Code navigation: run `codegraph init -y` once in your worktree first (about 30 seconds), then use `codegraph explore "<symbols or a question>"` before grep or reading files. `.codegraph` is git-ignored; never add or commit it. `npm ci` is complete or running in the background in your worktree; wait for it before running tests.

Rules:
- Do not push, merge or open a PR. Do not run `docker compose`, and do not touch `.env`, `data/` or production media.
- The WSL host is `192.168.1.119`. Work there only under `~/sonder-replication/`, and never touch `~/sonder-replication/issue6-1793194927`. Live verification scripts (`scripts/verify-*.mjs`) never run on the host.
- Verify with typecheck and unit tests: `npx tsc --noEmit`, `npx tsx --test <file>` and `npm test`. Run before reporting. Do not run the browser tests or `npm run check`; the coordinator runs them.
- Make unit tests build every repository, file and directory they need in a temporary directory. `npm run check` runs them in a `git archive` snapshot that has no `.git`, so a test that reads the surrounding checkout passes locally and fails there.
- Commands that take longer than 90 seconds go in the background with output in a log file that you poll, so you can read coordinator messages between polls: `orca orchestration check --terminal <your_handle> --json`.
- Check every command flag, option and environment variable with `--help` or grep before you use it or write it into a file. Do not assume one exists.
- When code must read another command's output (JSON, logs), run the command once and copy a real sample into your test. Do not guess the shape.
- Commit on your branch with a concise imperative subject. Reference the issue number in the message. No co-author trailer for opencode workers.
- If you hit a usage limit, stop working: commit the work so far with a message that says what is unfinished, and say so in your report. Do not keep retrying against an exhausted bucket.

Completion: your report lists every bullet of the Proposal, and next to each the test name or command that shows it works. Say plainly what you could not verify. A bullet with no evidence is not done.

## Model choice

- Agent: opencode
- Model: `nris/Qwen3.8-27B` (the only permitted OpenCode model; Orca's OpenCode launch rejects `--model`, so it runs as the configured default)
- Effort: none (unsupported for OpenCode)
- Why: #169 is a scripted slice with a fully specified interface (issue + Agent Brief) building on the committed #167/#168 code; it matches the mechanical capability tier in `docs/agents/models.md`.

## Task

- Issue: #169 — Account activation via invite link
- Branch: `jahnzh/issue-169-invite-activation`
- Base branch: `jahnzh/issue-168-resend-approval` (branch tip at dispatch time)

## Proposal (full text via `gh issue view 169`)

- Public endpoint `GET /api/invites/verify?token=...` (unauthenticated; add to the `onRequest` allowlist in `server/app.ts` alongside the other public routes): takes a raw hex token, looks up `hashToken(token)` in `account_invites`, and verifies the invite is unclaimed and unexpired. Returns `{ ok: true, username, email }` or a descriptive error (404 for unknown/claimed, 410 for expired — pick and document; the point is distinct, friendly messages).
- Public endpoint `POST /api/invites/claim` (unauthenticated): body `{ token, password }`, enforces the existing password schema (min 8 chars, `server/users.ts`), creates the user account (reusing the `POST /api/users` id/high-water and username-uniqueness rules; if the username is already taken, a clear error), marks the invite claimed (`claimed_at = Date.now()`), sets the `sonder_session` cookie exactly like `POST /api/auth/login` does (30-day expiry, `hashToken`-stored session row), and returns the authenticated user payload. The whole operation is idempotent-safe: a second claim with the same token fails clearly.
- Frontend: a `/join` view (the app serves `index.html` for non-`/api/` paths; route on the URL in `src/App.tsx` or `src/main.tsx`) that reads `?token=...`, calls `GET /api/invites/verify`, and shows a focused activation card with the prefilled (read-only) username, password + confirm-password fields with a show/hide toggle, and the same sign-in page design language as `src/components/SignIn.tsx` / `signin.css`.
- Submitting the activation form claims the invite, seeds user storage preferences (the `selectUserStorage` / `authDB` flow the sign-in page uses in `src/components/SignIn.tsx`), dispatches the `sonder:authenticated` event, and routes directly to the library.
- Visiting `/join` with an expired, malformed, or previously claimed token shows a dedicated error card with a link back to the sign-in page.
- End-to-end Playwright test(s) exercising the complete flow: admin creates a request, approves it, takes the invite link (from the admin UI), opens `/join?token=...`, sets a password, and lands signed in on the authenticated bookshelf; plus error states for expired (seed an expired invite directly in the test DB) and reused tokens. Write the spec but do not run browser tests.
- Fastify integration tests for verify (valid, unknown, claimed, expired) and claim (creates user + session, rejects weak password, rejects reuse).

## Constraints

- The raw token must never be stored or logged; lookups compare against `hashToken(token)`.
- Do not change the invite creation/expiry logic from #168; only read and claim.
- Schema changes, if any, stay additive and update both `server/db.ts` and `server/schema.ts` (none expected).
- Follow nearby conventions: two-space indent, kebab-case modules, `PascalCase` components, `camelCase` functions.

## Done when

Your report lists every bullet of the Proposal, and next to each the test name or command that shows it works; say plainly what you could not verify; a bullet with no evidence is not done.
