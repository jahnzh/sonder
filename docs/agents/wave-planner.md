# Wave planner

`scripts/orca-plan.mjs` recommends a coordinated assignment for a ready wave of tasks (#110, part of #103). It builds on `scripts/orca-recommend.mjs` for each task's Jev assessment and capability match, then balances concurrency, dependencies and shared usage across the wave. It never starts a worker. Worker history (#111) is not an input; learning from outcomes is #112.

```sh
node scripts/orca-plan.mjs --wave <file.json> [--models docs/agents/models.md] [--concurrency <n>]
node scripts/orca-plan.mjs --wave -   # read the wave from stdin
```

Run `--help` for every option. Pass each proposed `launch.args` to `scripts/orca-spawn.sh` after the existing preflight and receipt checks. The planner does not replace those checks.

## Wave file

```json
{
  "concurrency": 3,
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
| `concurrency` | Max workers including active ones (default 3, or `--concurrency`). Matches the repository guidance in `docs/agents/models.md`. |
| `completed` | Task ids whose dependencies are already satisfied. |
| `activeWorkers` | Workers already running; each counts against concurrency and against that agent's shared allowance. |
| `tasks[].ready` | `false` keeps the task out of assignment (`not-ready`). Default true. |
| `tasks[].dependsOn` | Ids that must be in `completed` (or outside the wave) before the task is assignable. A dependency that is also in this wave and not completed is `blocked`. |
| `tasks[].eligible` / `judgment` | Same meaning as `scripts/orca-recommend.mjs`. |

Only `--summary`, `--kind` and `--files` equivalents leave the machine for Jev. Keep summaries shareable.

## What the plan contains

- **`tasks[]`**: one row per input task, in input order. Statuses:
  - `proposed` — assignment with `launch.args` (`started: false`)
  - `needs-decision` — suitable unknown-capacity choice beside a weaker known-capacity option, or exhausted suitable beside a warned weaker alternative; coordinator chooses
  - `delay` — nothing suitable; reason names the assessed requirement and why stronger choices are unavailable
  - `deferred` — concurrency full; replan when a slot frees
  - `blocked` / `not-ready` / `needs-judgment`
- **`allowances`**: per-agent usage with provenance (`source`, `observedAt`, `freshness`), reset windows, and `sharedWith.active` / `sharedWith.proposed`. The note states that percentages are provider-specific and not comparable, and that capacity is a snapshot, not a reservation.
- **`notes`**: reminders that the planner never launches, that unknown/stale/low/exhausted stay distinct, and that history is not an input.

A fresh usage poll runs before planning for every agent `scripts/orca-usage.mjs` collects (Codex today). Claude and any agent without a collector stay `unknown`; do not treat that as capacity. Re-run the command when workers finish or usage changes.

## Balancing rules

1. Capability first: harder assessed requirements are planned before easier ones; among equals, tasks with **fewer** suitable candidates (scarcer pools) are planned before those with larger pools, so a one-slot wave prefers a sole-capable task over an open one.
2. Smallest suitable capability wins within a task; scarce sole-capable agents are left for tasks that only they can do when an equivalent alternative exists.
3. Roughly equivalent alternatives across agents are listed with `relation: "equivalent"`.
4. Shared load prefers agents with fewer active + proposed workers among equivalents. It does not compare percentage figures across providers or reserve capacity.
5. Exhausted suitable options may surface a warned weaker alternative (`weakerAlternative`) as `needs-decision`, or a pure `delay` when no weaker option exists. A `needs-decision` weaker alternative holds a concurrency slot and counts toward that agent's shared load the same way an uncertain suitable assignment does. The warning names the assessed requirement and why stronger choices are unavailable. Recommend marks below-capability rejects with `rejectionKind: "below-capability"` (the planner does not match English reason text).
6. A suitable choice with unconfirmed usage (`unknown`, `stale`, `unavailable`) beside a weaker choice with confirmed capacity shows both (`uncertaintyAlternative`) and also holds the slot.

## Related commands

- Single-task recommendation: `scripts/orca-recommend.mjs` (see "Recommend a worker" in `docs/agents/worker-spec.md`)
- Usage collector: `docs/agents/usage-collector.md`
- Capability baseline: `docs/agents/models.md`
- Outcome history (not used here): `docs/agents/worker-history.md`
