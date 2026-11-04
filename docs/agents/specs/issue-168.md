Repository: Sonder. Your worktree (created by the coordinator from the tip of `jahnzh/issue-167-account-requests`, which already contains the #167 account-requests code) is on branch `jahnzh/issue-168-resend-approval`. Read `AGENTS.md` in it first, and the `CLAUDE.md` for architecture. Read your issue with `gh issue view 168` — the last comment is the authoritative Agent Brief.

This is the `/implement` stage for ticket #168. Load and follow the `implement` skill: implement the ticket from the issue, call the `tdd` skill at the pre-agreed seams where possible, run typechecking regularly and single test files regularly, and run the full test suite once at the end. Commit your work to the current branch.

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
- Why: #168 is a scripted slice with a fully specified interface (issue + Agent Brief) building on the committed #167 code; it matches the mechanical capability tier in `docs/agents/models.md`.

## Task

- Issue: #168 — Resend email integration and admin request approval/decline
- Branch: `jahnzh/issue-168-resend-approval`
- Base branch: `jahnzh/issue-167-account-requests` (branch tip at dispatch time)

## Proposal (full text via `gh issue view 168`)

- Lightweight Resend HTTPS client module (new server module, kebab-case name) using native runtime `fetch`: `POST https://api.resend.com/emails` with `Authorization: Bearer $RESEND_API_KEY` and sender `EMAIL_FROM`. Per ADR `docs/adr/0001-resend-transactional-email.md`.
- Submitting an account request (`POST /api/account-requests` from #167) dispatches a notification email to `ADMIN_EMAIL` with the requester's username, email, and note. Failing gracefully (request still stored) when `RESEND_API_KEY`/`ADMIN_EMAIL`/`EMAIL_FROM` are unconfigured or the call errors.
- Additive `account_invites` SQLite table: `id` INTEGER PRIMARY KEY, `token` TEXT NOT NULL (the raw token stored hashed via the existing `hashToken` in `server/security.ts`), `email` TEXT NOT NULL, `username` TEXT NOT NULL, `account_request_id` INTEGER NOT NULL, `created_at` INTEGER NOT NULL, `expires_at` INTEGER NOT NULL, `claimed_at` INTEGER. Update BOTH `server/schema.ts` and `server/db.ts`, additive.
- Admin endpoint `POST /api/account-requests/:id/decline` (admin only): marks the request `declined` (`reviewed_at = Date.now()`), no outbound email.
- Admin endpoint `POST /api/account-requests/:id/approve` (admin only): marks the request `approved`, generates a 32-byte cryptographic invite token (hex), stores the hashed token in `account_invites` with `expires_at` 7 days out (`168 * 3600000` ms) and links `account_request_id` and the request's `invite_id`, then attempts to send the invitation email to the applicant containing the link `${APP_URL}/join?token=<raw token>` (fall back to the request's base URL / `http://localhost:3001` when `APP_URL` is unset — keep it simple and document the choice).
- If email dispatch fails or `RESEND_API_KEY` is absent, approval succeeds and returns `{ ok: true, inviteLink, emailDelivered: false }`.
- Admin Settings UI (the "Pending account requests" list from #167 in `AccountSettings` in `src/App.tsx`): "Approve" and "Decline" actions per request; after approval, an inline success alert showing the invite link with a one-click copy button and the delivery status.
- Tests (Fastify integration, extend the #167 test file or add a new one): Resend payload construction and mocked dispatch (mock the outbound HTTPS call to `api.resend.com` — e.g. by stubbing `fetch` or pointing the client at a local test server; no external network), admin alert on submission, silent decline, token expiration computation (7 days), and the delivery-failure fallback returning `emailDelivered: false`.

## Constraints

- The raw token must never be stored or logged; only `hashToken(token)` is persisted.
- Email dispatch failures never block request storage (submission) or approval.
- Schema changes stay additive and update both `server/db.ts` and `server/schema.ts`.
- Do not implement the `/join` activation endpoints or frontend (#169).
- Follow nearby conventions: two-space indent, kebab-case modules, `PascalCase` components, `camelCase` functions.

## Done when

Your report lists every bullet of the Proposal, and next to each the test name or command that shows it works; say plainly what you could not verify; a bullet with no evidence is not done.
