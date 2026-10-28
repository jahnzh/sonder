# Repository Guidelines

## Project Structure

Sonder is a React/TypeScript PWA backed by Fastify and SQLite. Client code is in `src/`, API and database code in `server/`, and the Python alignment service in `worker/`. Assets are in `public/`, scripts in `scripts/`, unit tests in `tests/`, and browser tests in `tests/e2e/`. Read the relevant `README.md` section before changing a workflow.

## Main flow

Every change moves through `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` → `/code-review` → `/retro`. The stage skills are user-invoked slash commands. When a stage's artifact is missing, stop and name the command for the user to run.

| Stage | Artifact in this repo | Next stage starts when |
| --- | --- | --- |
| `/grill-with-docs` | Terms in `GLOSSARY.md`; hard-to-reverse decisions as ADRs in `docs/adr/` | The plan is settled |
| `/to-spec` | The spec, published as a GitHub issue | The spec issue exists |
| `/to-tickets` | Tracer-bullet tickets as GitHub issues with native blocking links, labelled `needs-triage` and listed on roadmap #11 | `/triage` has set a ticket to `ready-for-agent` |
| `/implement` | One worktree and branch per ticket, built by a worker chosen under "Spawning subagents" | `npm run check -- --ref <commit>` passes on the committed revision |
| `/code-review` | Standards and spec findings for the branch | No finding is open |
| `/retro` | Improvements filed as `needs-triage` issues | — |

- A change small enough to build at once goes straight to `/implement`. It still has an issue, still passes the check, and still gets `/code-review`.
- Merge a branch and open its PR only after `/code-review` has no open finding. The standards axis reads the "Style and Testing" section below.
- An effort too large for one session starts with `/wayfinder`.

## Development and Checks

Use Node 24 and install dependencies with `npm ci`.

- `npm run dev` starts the API on port 3001 and Vite on 5173. Stop the production container first if it occupies port 3001.
- `npm run build` typechecks, builds the client and generates the service worker.
- `npm test` runs Node tests through `tsx`; `npm run test:browser` runs Playwright. Build first: browser tests serve `dist/`.
- `npm run check -- --ref <commit>` runs install, build and both test suites in an isolated snapshot of a committed revision. See `docs/LOCAL_CHECKS.md` for reports and options.

## CI over SSH

Run `npm run check -- --ref <commit>` by hand until the runner from #23 exists. The planned runner, `scripts/ci-ssh.sh`, runs CI on the WSL host at `192.168.1.119`, dispatched automatically on push to `main` and to agent fix branches. Check host access with `ssh -o BatchMode=yes -o ConnectTimeout=5 192.168.1.119 true`.

- Send a Git bundle of the committed revision to a unique temporary checkout on the host. Install dependencies and run `nice -n 10 npm run check -- --ref <commit>` there.
- Keep browsers headless and muted. Check that the host's Playwright browsers match the lockfile before the first run.
- Retrieve the report and logs, post the commit status, then clean up only that run's files and processes.
- Live verification scripts (`verify-*.mjs`) never run on the host. They target production and stay on the production machine.

If SSH is unreachable, run the same committed revision locally with `npm run check -- --ref <commit>`. Record the fallback, host, commit and result in the handoff. A test failure on the host is a failure: do not rerun locally to get a pass, and do not treat it as connectivity fallback.

## Style and Testing

Follow nearby TypeScript and React conventions: two-space indentation, `PascalCase` components, `camelCase` functions, and descriptive kebab-case module names. There is no configured linter; `npm run build` performs typechecking. Name unit tests `*.test.ts` or `*.test.mjs` and Playwright tests `*.spec.ts`. Add focused regression coverage for behavior changes; no coverage threshold is configured.

## Changes and Safety

Use concise, imperative commit subjects; history also uses scopes such as `fix(ci):` and issue references. PR descriptions should explain the change, link the issue, list checks and include screenshots for visual changes. Keep `.env`, `data/` and `artifacts/` private. Database schema changes must remain additive and update both `server/db.ts` and `server/schema.ts`. Read `docs/LOCAL_CHECKS.md` before backups or live verification.

## Agent skills

Agent skills setup follows the main flow from https://www.aihero.dev/skills-setup-matt-pocock-skills. It was run once for this repo with `/setup-matt-pocock-skills`; re-run it only to switch trackers or start over. Routine changes are made by editing the files below by hand.

- **Issue tracker**: GitHub issues on `jahnzh/sonder`, via `gh`. See `docs/agents/issue-tracker.md`. Pinned issue #11 is the roadmap.
- **Triage labels**: the five canonical roles map one-to-one to the labels on the repo (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.
- **Domain docs**: single-context layout, `GLOSSARY.md` plus `docs/adr/` (created lazily). See `docs/agents/domain.md`.

## Spawning subagents

Before spawning any subagent, decide the intelligence level the task needs and choose the agent and model to match. Do not default every worker to the same model.

- Give reasoning-heavy work (reproducing timing or rendering bugs, metric and analysis work, cross-file refactors) the most capable model available.
- Give mechanical work (a scripted change with a clear spec, a small UI edit) a smaller model.
- Set the model explicitly with `--model` and `--effort` rather than letting each agent use its default.
- Take model ids from the agent's own listing: `agent --list-models` for cursor, and the ids a launch receipt reports for claude and antigravity. Confirm the effective model in the receipt after launch.

Also consider usage limits when dividing work. Spread tasks across agents so no single provider's quota runs out mid-wave, and keep the number of concurrent workers modest. Record the choice and its reason in the spec or the handoff.
