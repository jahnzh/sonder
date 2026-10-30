# Learned adjustments

`scripts/orca-learn.mjs` derives conservative recommendation adjustments from worker history (#112, part of #103). It reads structured records only — never transcripts — and never starts a worker. Histories are never sent to Jev. `scripts/orca-recommend.mjs` and `scripts/orca-plan.mjs` apply the same rules and always show the capability-and-usage baseline beside any adjusted pick.

```sh
node scripts/orca-learn.mjs inspect [--history-dir <dir>] [--learn-dir <dir>] [--kind <kind>] [--difficulty <req>]
node scripts/orca-learn.mjs reset --yes [--learn-dir <dir>]
```

Run `--help` for every option. Directories default to `$ORCA_HISTORY_DIR` / `artifacts/orca/history` and `$ORCA_LEARN_DIR` / `artifacts/orca/learning` (both gitignored).

## Minimum evidence rule

A record is comparable to a candidate for task `(kind, difficulty)` only when all of these match exactly:

| Key | Source |
| --- | --- |
| agent | `agent.name` |
| model | `agent.effectiveModel` |
| effort | `agent.effectiveEffort` (unknown matches unknown) |
| agent version | `versions.agent` (unknown matches unknown only) |
| task kind | `task.type` |
| difficulty | `task.difficulty` (mechanical / standard / reasoning-heavy) |

Further gates:

- At least **3** comparable records with a known completion (`succeeded` or `failed`). Missing/`unknown` outcomes are excluded — they are not success.
- Each record’s weight decays with half-life **30 days** from `completedAt` (else `updatedAt`). Old evidence loses weight.
- An adjustment applies only when the **sum of decayed weights ≥ 2.0**; otherwise the combination stays `uncertain` and the baseline is used.
- Quality signals stay separate: completion, checks, reviews, follow-up fixes, retries, and attributable usage. There is no single opaque quality score.
- Shared usage is never treated as a per-worker cost and never enters the score.
- An override is recorded as a choice, not as a correctness label for the original recommendation. Learning scores the launched worker’s outcomes.
- Different agent versions are never pooled. Evidence from another version is listed under `versionMismatches` and does not move the pick.
- Suitable under-observed combinations may be proposed occasionally (~10% when the corpus already has some included evidence), marked `exploration` / `uncertain`. Nothing launches autonomously.

## What inspect shows

- The fixed baseline note (smallest suitable capability from `docs/agents/models.md`, then usage).
- Each learned adjustment with preference, raw and weighted counts, and the per-outcome evidence (ids, scores, signal breakdown).
- Combinations that remain uncertain for low evidence.
- Records excluded for missing outcomes or incomplete comparability keys.
- The current `resetAt` epoch, if any.

## Reset

`reset --yes` writes `{ resetAt }` into the learn directory. Evidence at or before that time is ignored for adjustments. Raw history records, shared usage and transcripts are untouched. Delete history separately with `orca-history.mjs` when that is what you want.

## How recommend and plan use it

- Capability tier is unchanged: learning only reorders within the smallest suitable capability level.
- Every recommendation includes `baselineRecommendation` next to the (possibly adjusted) `recommendation`, plus a `learning` object listing applied adjustments, uncertain combinations, version mismatches and any exploration pick.
- `--no-learning` forces the baseline only (baseline fields are still present).
- `--history-dir`, `--learn-dir` and `--agent-version <agent>=<version>` select the corpus and current tooling versions for comparability.

## Related

- Outcome history: `docs/agents/worker-history.md`
- Single-task recommendation: `docs/agents/worker-spec.md` (“Recommend a worker”)
- Wave planner: `docs/agents/wave-planner.md`
- Capability baseline: `docs/agents/models.md`
