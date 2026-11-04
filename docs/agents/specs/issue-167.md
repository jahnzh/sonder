Repository: Sonder, in `/home/jahn/orca/workspaces/audiobook_streamer/issue-167`. Your worktree is a checkout of base branch `main` on branch `jahnzh/issue-167-account-requests`. Read `AGENTS.md` in it first, and the `CLAUDE.md` for architecture. Read your issue with `gh issue view 167` — the last comment is the authoritative Agent Brief.

This is the `/implement` stage for ticket #167. Load and follow the `implement` skill: implement the ticket from the issue, call the `tdd` skill at the pre-agreed seams where possible, run typechecking regularly and single test files regularly, and run the full test suite once at the end. Commit your work to the current branch.

Code navigation: `codegraph init -y` has already been run in this worktree and `npm ci` is complete. Use `codegraph explore "<symbols or a question>"` before grep or reading files. `.codegraph` is git-ignored; never add or commit it.

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
- Why: #167 is a scripted vertical slice with fully specified interfaces (issue + Agent Brief); it matches the mechanical capability tier in `docs/agents/models.md`.

## Task

- Issue: #167 — Public account request submission and admin review queue
- Branch: `jahnzh/issue-167-account-requests`
- Base branch: `main`

## Proposal (full text via `gh issue view 167`)

- Additive `account_requests` SQLite table: `id` INTEGER PRIMARY KEY, `email` TEXT NOT NULL, `username` TEXT NOT NULL, `note` TEXT, `status` TEXT NOT NULL DEFAULT 'pending', `created_at` INTEGER NOT NULL, `reviewed_at` INTEGER, `invite_id` INTEGER. Update BOTH `server/schema.ts` (drizzle table definition) and `server/db.ts` (`CREATE TABLE IF NOT EXISTS`), keeping the change additive.
- Public endpoint `POST /api/account-requests` (unauthenticated), body `{ email, username, note?, honeypot? }` → `{ ok: true }`. Validate email syntax; username rule `^[a-z0-9._-]+$/i`, 2–40 chars (the same rule as `POST /api/users` in `server/users.ts`); reject the reserved username `admin` case-insensitively. A non-empty `honeypot` value is a blocked automated submission: respond with a 400 validation error and store nothing. IP rate-limiting: max 3 requests per hour per IP using the existing per-route `@fastify/rate-limit` config pattern (see `/api/auth/login` in `server/app.ts`: `{ config: { rateLimit: { max, timeWindow, keyGenerator: (request) => request.ip } } }`).
- Public reachability: the `onRequest` hook in `server/app.ts` allowlists only `/api/auth/status`, `/api/auth/login`, `/api/health`; add the account-requests POST there so unauthenticated submission works.
- Admin endpoint `GET /api/account-requests`: requires the admin role (use `requireAdmin`, same pattern as `GET /api/users`), returns the array of pending account requests with `id`, `email`, `username`, `note`, `createdAt`.
- `src/components/SignIn.tsx`: when `GET /api/auth/status` reports `required: true`, show a "Request an account" link below the sign-in form. It opens an accessible dialog collecting email, desired username, and an optional note, with a hidden honeypot field, client-side format validation matching the server rules, and a confirmation state on success. Reuse the existing `Dialog` component and `signin.css` conventions.
- Admin Settings → Users: the admin "Users" section of `AccountSettings` in `src/App.tsx` (heading `Users`) must display a "Pending account requests" list with username, email, note, and relative submission time, fetched from `GET /api/account-requests`.
- Tests: Fastify integration tests (extend `tests/users.test.ts` or add `tests/account-requests.test.ts`) covering public submission, validation failures, honeypot rejection, rate limiting (use distinct `x-forwarded-for` IPs, as the existing login rate-limit test does — the app runs `trustProxy: "loopback"`), and admin queue visibility; none may require email credentials or external network. A Playwright spec (extend `tests/e2e/users.spec.ts` or add `tests/e2e/account-requests.spec.ts`) following the `tests/browser-server.ts` harness pattern: unauthenticated sign-in page shows the "Request an account" trigger, submission succeeds, and the admin Settings queue shows the request. The browser server runs with `APP_PASSWORD` set, so authentication is required and the trigger is visible. Write the spec but do not run browser tests.
- The worktree contains two uncommitted artifacts from the #166 grill stage that must be included in your commit: the modified `GLOSSARY.md` (terms "Account request" and "Invite link") and the new `docs/adr/0001-resend-transactional-email.md`.

## Constraints

- Schema changes stay additive and update both `server/db.ts` and `server/schema.ts`.
- No outbound email or Resend in this ticket (#168), no approve/decline actions (#168), no invite tokens (#169).
- Do not add `/api/account-requests` to the `preHandler` admin-route regex list in `server/app.ts`; the GET route is protected by `requireAdmin` in the handler, matching `GET /api/users`.
- Follow nearby conventions: two-space indent, kebab-case modules, `PascalCase` components, `camelCase` functions.

## Done when

Your report lists every bullet of the Proposal, and next to each the test name or command that shows it works; say plainly what you could not verify; a bullet with no evidence is not done.
