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

Cursor's full list is available with `agent --list-models`.

## Capability

`scripts/orca-recommend.mjs` reads this table, so give every new row a Capability, keep effort values in backticks in ascending order, and keep this as the first table in the file. A row with any other Capability value is never recommended.

- `reasoning-heavy`: bug reproduction, timing or rendering issues, metric and analysis work, cross-file refactors.
- `standard`: analysis, diagnosis and scripting with a clear spec.
- `mechanical`: a scripted change with a clear spec, a small UI edit, documentation.

A row meets its own level and those below it. The levels are the coordinator's reading of the Suits column and the observations below, not a measurement. Codex is `standard` rather than `reasoning-heavy` because it went silent twice.

## Usage limits

Usage-limit figures are supplied by the user, as no tool reports them, so `scripts/orca-recommend.mjs` reports usage as `unknown`. The coordinator should spread workers across providers and keep the number concurrent modest.

## Cursor status

Orca's agent status hooks are not installed for cursor (`orca agent hooks status` shows `cursor: not_installed`), so cursor workers report no provider and an `unverifiable` liveness on the board. They still send orchestration heartbeats. Enabling the hook writes `~/.cursor/hooks.json` and is the user's decision.

## How to verify

Launch a subagent with `--model`, read the effective model in the launch receipt, and update the "Last verified" date in the table above.

## Observed behaviour (2026-10-30)

- Codex `gpt-6.1-terra` at `max` went `stale_status` twice (#77 after about 94 minutes, #25 after about 45) with its work uncommitted and no `worker_done`, and did not answer a status request. Follow the liveness playbook in `docs/agents/worker-spec.md` (check `worker-list` liveness, nudge once, then `worker-stop`, preflight `--after-stop` and finish or respawn). Its uncommitted code was good, so inspect the worktree before discarding it.
- Claude `claude-sonnet-5-5` at `high` was reliable for fix lists on existing code (#79 and #25 review fixes), with mutation proofs for each fix.
- Cursor `auto` workers can report ambient failures as "noise": check them (the unit suite failures in #78/#36 were a full local disk, #89).
- Keep concurrency at three workers and one `ci:deck` at a time; check `df -h /` first (keep more than 15 GB free).
