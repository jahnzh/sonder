# Wave planner

`scripts/orca-plan.mjs` recommends a coordinated assignment for a ready wave of tasks (#110, part of #103). It builds on `scripts/orca-recommend.mjs` for each task's Jev assessment and capability match, then balances concurrency, dependencies and shared usage across the wave. It never starts a worker. When worker history has enough comparable outcomes, learning (#112) may reorder within a capability tier; each task still shows `baselineRecommendation` beside any adjusted pick (see `docs/agents/learned-adjustments.md`). Transcripts are never read or sent to Jev.

```sh
node scripts/orca-plan.mjs --wave <file.json> [--models docs/agents/models.md] [--policy docs/agents/routing-policy.json] [--workers worker-list.json] [--concurrency <n>]
node scripts/orca-plan.mjs --wave -   # read the wave from stdin
```

Run `--help` for every option. `--policy` selects the routing policy (default: `routing-policy.json` beside `--models`; see `docs/agents/routing-policy.md`). `--workers` loads active workers from an `orca orchestration worker-list --json` receipt so per-bucket caps count real load. Pass each proposed `launch.args` to `scripts/orca-spawn.sh` after the existing preflight and receipt checks. The planner does not replace those checks.

## Wave file

```json
{
  "concurrency": 5,
  "completed": ["105"],
  "activeWorkers": [
    { "agent": "codex", "model": "gpt-6.1-terra", "effort": "max", "dispatchId": "ctx_…" }
  ],
  "tasks": [
    {
      "id": "110",
      "summary": "Shareable one-paragraph task description",
      "kind": "feature",
      "files": 4,
      "dependsOn": ["105"],
      "ready": true,
      "eligible": ["cursor/auto"],
      "judgment": "standard",
      "judgmentReason": "clear scripted change"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `concurrency` | Max workers including active ones (default 5, or `--concurrency`). Matches `maxConcurrentTotal` in `docs/agents/routing-policy.json` and the guidance in `docs/agents/models.md`; a policy still caps it at `maxConcurrentTotal`. |
| `completed` | Task ids whose dependencies are already satisfied. |
| `activeWorkers` | Workers already running; each counts against concurrency and against that agent's shared allowance. |
| `tasks[].ready` | `false` keeps the task out of assignment (`not-ready`). Default true. |
| `tasks[].dependsOn` | Ids that must be in `completed` (or outside the wave) before the task is assignable. A dependency that is also in this wave and not completed is `blocked`. |
| `tasks[].eligible` / `judgment` | Same meaning as `scripts/orca-recommend.mjs`. |
| `tasks[].reviewOf` | Optional `<agent>/<model>[/<effort>]` implementer; with `reviewerOnDifferentPool`, the reviewer must use another agent and binding bucket. |

Only `--summary`, `--kind` and `--files` equivalents leave the machine for Jev. Keep summaries shareable.

## What the plan contains

- **`tasks[]`**: one row per input task, in input order. Statuses:
  - `proposed` — assignment with `launch.args` (`started: false`)
  - `needs-decision` — suitable unknown-capacity choice beside a weaker known-capacity option, or exhausted suitable beside a warned weaker alternative; coordinator chooses
  - `delay` — nothing suitable; reason names the assessed requirement and why stronger choices are unavailable
  - `deferred` — concurrency full; replan when a slot frees
  - `blocked` / `not-ready` / `needs-judgment`
- **`allowances`**: per-agent usage with provenance (`source`, `observedAt`, `freshness`), reset windows, and `sharedWith.active` / `sharedWith.proposed`. The note states that percentages are provider-specific and not comparable, and that capacity is a snapshot, not a reservation.
- **`usageByCandidate`**: per `agent/model` assessments (same fields as agent reports, plus `buckets`) so two Antigravity Gemini models share an allowance while Argon does not, and Cursor Models stays separate from Other Models.
- **`allowancesByBucket`**: keyed `agent/<bucket-id>`, with `sharedWith` listing only active/proposed workers whose candidate assessment includes that bucket.
- **`notes`**: reminders that the planner never launches, that unknown/stale/low/exhausted stay distinct, and that learning keeps the baseline visible and never reads transcripts.

A fresh usage poll runs before planning for every agent `scripts/orca-usage.mjs` collects (Claude, Codex, Cursor, Antigravity). An agent missing from the baseline is omitted; a failed or unknown reading stays `unknown` / `unavailable` and must not be treated as capacity. Re-run the command when workers finish or usage changes. See `docs/agents/dispatch-evaluation.md` for how the planner, collector, history and evaluation fit normal orchestration.

## Balancing rules

1. Capability first: harder assessed requirements are planned before easier ones; among equals, tasks with **fewer** suitable candidates (scarcer pools) are planned before those with larger pools, so a one-slot wave prefers a sole-capable task over an open one.
2. With a routing policy (`--policy` / default beside the baseline): allow-list and reserves apply; within the smallest available allowed tier pick by **burn pressure**; `maxConcurrentTotal` caps wave concurrency; `maxConcurrentPerBucket` counts active + proposed workers per binding bucket (see `docs/agents/routing-policy.md`).
3. Without a policy file: smallest suitable capability wins within a task; scarce sole-capable agents are left for tasks that only they can do when an equivalent alternative exists; shared load prefers agents with fewer active + proposed workers among equivalents without comparing percentage figures across providers.
4. Roughly equivalent alternatives across agents are listed with `relation: "equivalent"` (and pressure/binding when a policy is active).
5. Exhausted suitable options may surface a warned weaker alternative (`weakerAlternative`) as `needs-decision`, or a pure `delay` when no weaker option exists. A `needs-decision` weaker alternative holds a concurrency slot and counts toward that agent's shared load the same way an uncertain suitable assignment does. The warning names the assessed requirement and why stronger choices are unavailable. Recommend marks below-capability rejects with `rejectionKind: "below-capability"` (the planner does not match English reason text).
6. A suitable choice with unconfirmed usage (`unknown`, `stale`, `unavailable`) beside a weaker choice with confirmed capacity shows both (`uncertaintyAlternative`) and also holds the slot.

## Related commands

- Single-task recommendation: `scripts/orca-recommend.mjs` (see "Recommend a worker" in `docs/agents/worker-spec.md`)
- Routing policy: `docs/agents/routing-policy.md` (`--policy`)
- Usage collector: `docs/agents/usage-collector.md`
- Capability baseline: `docs/agents/models.md`
- Outcome history: `docs/agents/worker-history.md`
- Learned adjustments: `docs/agents/learned-adjustments.md`
