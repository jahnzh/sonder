# Verified Subagent Models

Verified model IDs and effort settings for spawning subagents.

| Agent       | Model ID              | Supported effort values | Capability      | Suits                                                                      | Last verified |
| ----------- | --------------------- | ----------------------- | --------------- | -------------------------------------------------------------------------- | ------------- |
| claude      | `claude-opus-5-5`     | `high`                  | reasoning-heavy | Reasoning-heavy work such as bug reproduction, timing issues and cross-file changes | 2026-10-28    |
| claude      | `claude-sonnet-5-5`   | `medium`, `high`        | standard        | Analysis, diagnosis and scripting with a clear spec                        | 2026-10-28    |
| antigravity | `gemini-4-argon-high` | none                    | mechanical      | Small mechanical changes and documentation                                 | 2026-10-28    |
| cursor      | `composer-2.5`        | none                    | standard        | Scripting with a clear spec                                                | 2026-10-28    |
| antigravity | `gemini-3.8-flash-high` | none                  | mechanical      | Small mechanical changes with a clear spec (#80 font redraw)               | 2026-10-30    |
| cursor      | `auto`                | none                    | standard        | Test-infrastructure and review work (#34, #36/#78, reviews of #77 and #25) | 2026-10-30    |
| codex       | `gpt-6.1-terra`       | `max`                   | standard        | Larger client changes; went silent twice (see below)                       | 2026-10-30    |
| antigravity | `claude-opus-5-5-high` | none                   | reasoning-heavy | Reasoning-heavy work through Antigravity's Claude and GPT models bucket, separate from Claude Code | 2026-10-31    |
| antigravity | `claude-sonnet-5-5-medium` | none               | standard        | Analysis, diagnosis and scripting with a clear spec, through Antigravity's Claude and GPT models bucket | 2026-10-31    |

Cursor's full list is available with `agent --list-models`.

## Capability

`scripts/orca-recommend.mjs` reads this table, so give every new row a Capability, keep effort values in backticks in ascending order, and keep this as the first table in the file. A row with any other Capability value is never recommended.

- `reasoning-heavy`: bug reproduction, timing or rendering issues, metric and analysis work, cross-file refactors.
- `standard`: analysis, diagnosis and scripting with a clear spec.
- `mechanical`: a scripted change with a clear spec, a small UI edit, documentation.

A row meets its own level and those below it. The levels are the coordinator's reading of the Suits column and the observations below, not a measurement. Codex is `standard` rather than `reasoning-heavy` because it went silent twice.

## Usage limits

`scripts/orca-recommend.mjs` and `scripts/orca-plan.mjs` refresh Claude, Codex, Cursor and Antigravity usage from the collector before recommending (`docs/agents/usage-collector.md`). Failed or missing readings stay `unknown` / `unavailable` and are never treated as confirmed capacity. Which agents and models may run is governed by `docs/agents/routing-policy.md` (policy C allow-list, safety floor, burn-pressure ranking, concurrency caps). For a ready wave, the planner applies that policy across tasks (`docs/agents/wave-planner.md`). The coordinator still keeps the number concurrent modest (default plan limit: three).

## Quota buckets

Each documented model draws from a provider-specific quota bucket. The recommender and planner assess **per candidate** (`agent/model`), not one number per agent. Readers: `scripts/antigravity-usage.mjs`, `scripts/cursor-usage.mjs`, `scripts/claude-usage.mjs`, `scripts/codex-usage.mjs` (`assessCandidateUsage`).

| Agent | Model | Bucket (owner UI / reader id) | Reader |
| --- | --- | --- | --- |
| antigravity | `gemini-3.8-flash-high` | Gemini Models (`gemini-weekly`, `gemini-5h`) | `antigravity-usage.mjs` |
| antigravity | `gemini-4-argon-high` | Gemini 4 Argon (`gemini-argon-wtu-weekly`) — separate from Gemini Models | `antigravity-usage.mjs` |
| antigravity | `claude-opus-5-5-high`, `claude-sonnet-5-5-medium` | Claude and GPT models (`3p-weekly`, `3p-5h`) — separate from Gemini Models and from Claude Code | `antigravity-usage.mjs` |
| cursor | `auto`, `composer-2.5` (and other `included_auto` applicable models) | Cursor Models (`included_auto`) plus Plan (`included_total`) | `cursor-usage.mjs` |
| cursor | named API models outside that list | Other Models (`included_api`) plus Plan | `cursor-usage.mjs` |
| claude | every documented Claude model | shared Claude session / week windows | `claude-usage.mjs` |
| codex | every documented Codex model | one Codex allowance (`codex-5h`, `codex-weekly`) | `codex-usage.mjs` |

Unrecognised model ids stay `unknown` (never treated as available). Exhaustion of Argon or Other Models does not exhaust Flash or Cursor Models. When a candidate has weekly and 5-hour windows, status follows the **worst** window and the reason names that window's reset.

### Antigravity (`agy`) notes

- `agy models` (subcommand) is the source for what Antigravity can run. Effort is baked into the model id (`…-low` / `…-medium` / `…-high`), so verified table rows keep Effort `none`. The CLI also accepts `--effort`; do not change launch behaviour until a row is re-verified with it.
- Only `gemini-4-argon-high`, `gemini-3.8-flash-high`, `claude-opus-5-5-high` and `claude-sonnet-5-5-medium` are **verified** rows today (the two Claude rows passed a real launch on 2026-10-31: the receipt showed the requested effective model, a read-only task ran and the worker reported its own model id) (a row needs a real launch check). Other ids from `agy models` are recognised for quota mapping but not verified for spawn:

| Model id | Quota bucket |
| --- | --- |
| `gemini-4-argon-low`, `gemini-4-argon-medium` | Gemini 4 Argon |
| `gemini-3.8-flash-low`, `gemini-3.8-flash-medium` | Gemini Models |
| `claude-opus-5-5-{low,medium}`, `claude-sonnet-5-5-{low,high}`, `gpt-oss-120b-medium` | Claude and GPT models |

- The owner UI may render the Argon limit as two rows ("Gemini 4 Argon" and "Weekly"); raw `/usage` has a single Argon weekly window. That is not a global weekly cap and does not affect Gemini Models or third-party groups.

## Cursor status

Orca's agent status hooks are not installed for cursor (`orca agent hooks status` shows `cursor: not_installed`), so cursor workers report no provider and an `unverifiable` liveness on the board. They still send orchestration heartbeats. Enabling the hook writes `~/.cursor/hooks.json` and is the user's decision.

## How to verify

Launch a subagent with `--model`, read the effective model in the launch receipt, and update the "Last verified" date in the table above.

## Observed behaviour (2026-10-30)

- Codex `gpt-6.1-terra` at `max` went `stale_status` twice (#77 after about 94 minutes, #25 after about 45) with its work uncommitted and no `worker_done`, and did not answer a status request. Follow the liveness playbook in `docs/agents/worker-spec.md` (check `worker-list` liveness, nudge once, then `worker-stop`, preflight `--after-stop` and finish or respawn). Its uncommitted code was good, so inspect the worktree before discarding it.
- Claude `claude-sonnet-5-5` at `high` was reliable for fix lists on existing code (#79 and #25 review fixes), with mutation proofs for each fix.
- Cursor `auto` workers can report ambient failures as "noise": check them (the unit suite failures in #78/#36 were a full local disk, #89).
- Keep concurrency at three workers and one `ci:deck` at a time; check `df -h /` first (keep more than 15 GB free).
