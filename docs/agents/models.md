# Verified Subagent Models

Verified model IDs and effort settings for spawning subagents.

| Agent       | Model ID              | Supported effort values | Suits                                                                      | Last verified |
| ----------- | --------------------- | ----------------------- | -------------------------------------------------------------------------- | ------------- |
| claude      | `claude-opus-5-5`     | `high`                  | Reasoning-heavy work such as bug reproduction, timing issues and cross-file changes | 2026-10-28    |
| claude      | `claude-sonnet-5-5`   | `medium`, `high`        | Analysis, diagnosis and scripting with a clear spec                        | 2026-10-28    |
| antigravity | `gemini-4-argon-high` | none                    | Small mechanical changes and documentation                                 | 2026-10-28    |
| cursor      | `composer-2.5`        | none                    | Scripting with a clear spec                                                | 2026-10-28    |

Cursor's full list is available with `agent --list-models`.

## Usage limits

Usage-limit figures are supplied by the user, as no tool reports them. The coordinator should spread workers across providers and keep the number concurrent modest.

## Cursor status

Orca's agent status hooks are not installed for cursor (`orca agent hooks status` shows `cursor: not_installed`), so cursor workers report no provider and an `unverifiable` liveness on the board. They still send orchestration heartbeats. Enabling the hook writes `~/.cursor/hooks.json` and is the user's decision.

## How to verify

Launch a subagent with `--model`, read the effective model in the launch receipt, and update the "Last verified" date in the table above.
