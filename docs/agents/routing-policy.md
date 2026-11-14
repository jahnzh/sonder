# Routing policy

The recommender (`scripts/orca-recommend.mjs`) and wave planner (`scripts/orca-plan.mjs`) read `docs/agents/routing-policy.json` (or `--policy <file>`) before choosing a worker. Capability (Jev / `--judgment`) stays a hard filter; within the smallest available allowed tier they rank by **burn pressure**. Learning (#112) may reorder inside that tier but never past the policy.

Read this before changing dispatch rules. Model discovery (`scripts/orca-models.mjs`) is a separate ticket (part B).

## Owner decision 2026-11-14 (Claude Max, November 2026)

The owner holds a Claude Max subscription for November 2026 ("I have Claude max subscription for this month. Use it", 2026-11-14), so Claude Code is now an allowed worker agent. **Re-check this in December 2026**: if the subscription is not renewed, remove the `claude` allow entry and put the reserve entry back (see "How to change").

- Claude Code: `claude-opus-5-5` and `claude-sonnet-5-5` are allowed. The `claude` reserve entry is gone, and `claude` is first in `order`.
- Antigravity's Claude models stay allowed beside Claude Code (they draw from a different bucket).
- Concurrency caps: `maxConcurrentPerBucket: 3` and `maxConcurrentTotal: 3` (before this 2 and 3). The owner asked to raise the caps for the Max plan and gave no numbers; the coordinator first chose 4 and 5. On 2026-11-14 four Claude workers, one Codex reviewer and a check dispatch ran together on the coordinator host (4 cores, 15 GB RAM): the host ran out of memory at about 19:20Z and had to be reset. **The limit is the host's memory, not the subscription**, so the total stays at 3 and only the per-bucket cap rises, which lets all three workers be Claude. Raise the total only after workers run on a host with more memory.
- First-guess expected share of the Claude weekly window: Opus 10 %, Sonnet 5 %. Three Claude workers moved the week from about 2 % to 5 % on 2026-11-14, so these are guesses; `bucketCostNotes` says so. Worker history (`meanBucketDeltaPercent`) replaces them once measured.

## Owner decision 2026-10-31 (policy C)

Allowed workers on 2026-10-31 (Claude Code was reserved then; see the 2026-11-14 decision above):

- Cursor Models: `auto`, `composer-*` (free / included_auto bucket)
- Antigravity: `claude-opus-5-5-high`, `claude-sonnet-5-5-medium`, `gemini-3.8-flash-high`
- Codex: `gpt-6.1-terra`
- OpenCode: `nris/Qwen3.8-27B` (free, no quota, temporary)

Reserved / excluded:

- Claude Code (`claude/*`) — the coordinator's own subscription fuel (lifted on 2026-11-14)
- Antigravity `gemini-4-argon-high` — excluded while its weekly bucket is exhausted (remove the reserve entry after it resets)

## File fields

Every key in `routing-policy.json`:

| Field | Meaning |
| --- | --- |
| `version` | Policy schema version (integer). |
| `decidedAt` | Date the owner locked this policy (ISO date). |
| `decision` | Human summary of the current policy (policy C as updated on 2026-11-14). |
| `allow` | Allow-list: `{ agent, models[] }`. Models may be exact ids, a trailing `prefix*`, or `*`. |
| `reserve` | Same shape plus required `reason`. Matched candidates are listed under `excluded` (not silently dropped). |
| `order` | Agent tie-break when burn pressures are within 5% of each other (the repository file lists claude, antigravity, codex, cursor, opencode). |
| `safetyFloorPercent` | Skip a candidate whose **binding** non-5-hour window has less than this percent left (default 10). |
| `maxConcurrentPerBucket` | Max active+proposed workers sharing one agent/bucket id (default 2 when no policy file applies; the repository file sets 3). |
| `maxConcurrentTotal` | Cap on wave concurrency including active workers (default 3 when no policy file applies; the repository file sets 3). |
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

`expectedBucketSharePercent` values serve as initial fallback guesses (Opus high 35, Sonnet medium 12, Codex terra max 10, Cursor auto 3, Gemini Flash 3, and since 2026-11-14 Claude Code Opus 10 and Sonnet 5 as guesses). Worker history records measured lifetime bucket cost deltas (`usage.bucketCost`), learning aggregates them into `meanBucketDeltaPercent` (#124 Part C), and the chooser uses the learned bucket delta when available instead of the fallback guess. In all cases the chooser reports the expected share (annotated with source: learned vs policy) and refuses a dispatch that would leave the binding window under the safety floor after that share.

## How to change

1. Edit `docs/agents/routing-policy.json` (strict JSON; unknown fields and bad types fail load with the file and field named).
2. Keep `reserve` reasons specific so `excluded` rows stay explainable. To reserve an agent again, drop its `allow` entry and add `{ agent, models, reason }` under `reserve`; `tests/orca-routing.test.ts` covers the reserve mechanism with a policy built in the test, so it passes whether or not the repository file reserves anything for Claude.
3. Run `npx tsx --test tests/orca-routing.test.ts`.
4. Smoke with `node scripts/orca-recommend.mjs --task t --summary x --judgment <tier> --judgment-reason r --no-learning` for reasoning-heavy, standard and mechanical against a live collector reading.

Do not encode owner overrides on every spawn once the allow-list matches policy C; use `--override` only for a deliberate deviation (recorded as `policyDeviation`).
