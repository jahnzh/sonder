# Routing policy

The recommender (`scripts/orca-recommend.mjs`) and wave planner (`scripts/orca-plan.mjs`) read `docs/agents/routing-policy.json` (or `--policy <file>`) before choosing a worker. Capability (Jev / `--judgment`) stays a hard filter; within the smallest available allowed tier they rank by **burn pressure**. Learning (#112) may reorder inside that tier but never past the policy.

Read this before changing dispatch rules. Model discovery (`scripts/orca-models.mjs`) is a separate ticket (part B).

## Owner decision 2026-10-31 (policy C)

Allowed workers:

- Cursor Models: `auto`, `composer-*` (free / included_auto bucket)
- Antigravity: `claude-opus-5-5-high`, `claude-sonnet-5-5-medium`, `gemini-3.8-flash-high`
- Codex: `gpt-6.1-terra`

Reserved / excluded:

- Claude Code (`claude/*`) — the coordinator's own subscription fuel
- Antigravity `gemini-4-argon-high` — excluded while its weekly bucket is exhausted (remove the reserve entry after it resets)

## File fields

Every key in `routing-policy.json`:

| Field | Meaning |
| --- | --- |
| `version` | Policy schema version (integer). |
| `decidedAt` | Date the owner locked this policy (ISO date). |
| `decision` | Human summary of policy C. |
| `allow` | Allow-list: `{ agent, models[] }`. Models may be exact ids, a trailing `prefix*`, or `*`. |
| `reserve` | Same shape plus required `reason`. Matched candidates are listed under `excluded` (not silently dropped). |
| `order` | Agent tie-break when burn pressures are within 5% of each other (default: antigravity, codex, cursor). |
| `safetyFloorPercent` | Skip a candidate whose **binding** non-5-hour window has less than this percent left (default 10). |
| `maxConcurrentPerBucket` | Max active+proposed workers sharing one agent/bucket id (default 2). |
| `maxConcurrentTotal` | Cap on wave concurrency including active workers (default 3). |
| `expiringBoost` | Multiplier for pressure when the binding window resets within 48 h and has more than 20% left (default `1.0` = no effect). |
| `reviewerOnDifferentPool` | When true, `--review-of` / wave `reviewOf` excludes the implementer's agent and binding bucket. |
| `maxBucketSharePerWorkerPercent` | Default expected percent a worker may take from its binding window when the model is not in `expectedBucketSharePercent` (default 25). |
| `expectedBucketSharePercent` | Per-model expected share `{ agent, model, percent }`. Before dispatch the chooser reports this share and refuses a bucket where `percentLeft - share` would fall below `safetyFloorPercent`. |
| `bucketCostNotes` | Free-text cost finding for operators (not parsed for logic). |

## Burn pressure

For each candidate with confirmed capacity (`fresh` / `low`):

1. Ignore 5-hour / session windows for ranking (they only inform concurrency caps).
2. Among remaining windows, the **binding** window is the one with the lowest percent left.
3. `pressure = percentLeft / max(daysToReset, 0.05)`, then multiply by `expiringBoost` when that boost applies.
4. Rank highest pressure first; ties within 5% of the higher value follow `order`.

Reports name the pressure, binding bucket label, percent left and reset. The old "equivalent choices are not balanced by quota" line is replaced by that text when a policy allow-list is active.

## Expected share (cost awareness)

One Opus 5.5 (high) worker on Antigravity moved the Claude and GPT models weekly bucket from **3.7% to 50.7% used in about 10 minutes** (2026-10-31). A bucket that looks large can be small for high-effort work.

`expectedBucketSharePercent` values are **first guesses** (Opus high 35, Sonnet medium 12, Codex terra max 10, Cursor auto 3, Gemini Flash 3). Part C will replace them with measured deltas from worker history. Until then the chooser still reports the expected share and refuses a dispatch that would leave the binding window under the safety floor after that share.

## How to change

1. Edit `docs/agents/routing-policy.json` (strict JSON; unknown fields and bad types fail load with the file and field named).
2. Keep `reserve` reasons specific so `excluded` rows stay explainable.
3. Run `npx tsx --test tests/orca-routing.test.ts`.
4. Smoke with `node scripts/orca-recommend.mjs --task t --summary x --judgment <tier> --judgment-reason r --no-learning` for reasoning-heavy, standard and mechanical against a live collector reading.

Do not encode owner overrides on every spawn once the allow-list matches policy C; use `--override` only for a deliberate deviation (recorded as `policyDeviation`).
