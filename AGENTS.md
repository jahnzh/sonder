# Repository Guidelines

## Project Structure

Sonder is a React/TypeScript PWA backed by Fastify and SQLite. Client code is in `src/`, API and database code in `server/`, and the Python alignment service in `worker/`. Assets are in `public/`, scripts in `scripts/`, unit tests in `tests/`, and browser tests in `tests/e2e/`. Read the relevant `README.md` section before changing a workflow.

## Development and Checks

Use Node 24 and install dependencies with `npm ci`.

- `npm run dev` starts the API on port 3001 and Vite on 5173. Stop the production container first if it occupies port 3001.
- `npm run build` typechecks, builds the client and generates the service worker.
- `npm test` runs Node tests through `tsx`; `npm run test:browser` runs Playwright. Build first: browser tests serve `dist/`.
- `npm run check -- --ref <commit>` runs install, build and both test suites in an isolated snapshot of a committed revision. See `docs/LOCAL_CHECKS.md` for reports and options.

## CI over SSH

Prefer the WSL host at `192.168.1.119` when available. Check access with `ssh -o BatchMode=yes -o ConnectTimeout=5 192.168.1.119 true`. Transfer a Git bundle and clone the committed revision into a unique temporary checkout. Install the Playwright browsers required by the lockfile and run `nice -n 10 npm run check -- --ref <commit>`. Keep browsers headless and muted. Retrieve the report and logs, then clean up only that run's files and processes. SSH dispatch is manual.

If SSH is unavailable, run the same committed revision locally with `npm run check -- --ref <commit>`. Record the host, commit and result in the handoff. Report remote test failures as failures; do not treat them as connectivity fallback.

## Style and Testing

Follow nearby TypeScript and React conventions: two-space indentation, `PascalCase` components, `camelCase` functions, and descriptive kebab-case module names. There is no configured linter; `npm run build` performs typechecking. Name unit tests `*.test.ts` or `*.test.mjs` and Playwright tests `*.spec.ts`. Add focused regression coverage for behavior changes; no coverage threshold is configured.

## Changes and Safety

Use concise, imperative commit subjects; history also uses scopes such as `fix(ci):` and issue references. PR descriptions should explain the change, link the issue, list checks and include screenshots for visual changes. Keep `.env`, `data/` and `artifacts/` private. Database schema changes must remain additive and update both `server/db.ts` and `server/schema.ts`. Read `docs/LOCAL_CHECKS.md` before backups or live verification.
