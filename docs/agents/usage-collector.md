# Usage collector

`scripts/orca-usage.mjs` keeps a local history of provider usage and feeds `scripts/orca-recommend.mjs` / `scripts/orca-plan.mjs`. It starts with the machine as a systemd user service and polls every minute whether or not any orchestration is running. It collects Claude, Codex, Cursor, Antigravity and OpenCode (#106, #107–#109, #113). Each provider keeps its own windows and interpretation; percentages are never compared across agents. Reader details: `docs/agents/claude-usage.md`, `docs/agents/codex-usage.md`, `docs/agents/cursor-usage.md`, `docs/agents/antigravity-usage.md`, `docs/agents/opencode-usage.md`.

## Provider contract (per-candidate quota)

Every usage reader must export `assessCandidateUsage(observation, candidate, now)` next to `assess*Usage`:

1. Resolve `candidate.model` to the allowance bucket(s) that model draws from (reuse the reader's family/bucket helpers; do not duplicate mapping tables).
2. Return the shared assessment shape (`status` one of `fresh` | `low` | `exhausted` | `stale` | `unavailable` | `unknown`, `reason`, `resetsAt`, `source`-ready fields via `usageReport`, `capacityConfirmed`, plus `buckets: [{ id, label, usedPercent, resetsAt }]` naming those windows).
3. Return `unknown` (never `fresh` / available) when the model cannot be placed on a reported bucket.
4. Register the function as `assessCandidate` on that provider's `PROVIDERS` row in `scripts/orca-usage.mjs`.

### Adding a provider or model

1. Add or update the row in `docs/agents/models.md` and the **Quota buckets** section (which bucket the model draws from, which reader).
2. Capture a real reading (redact to fingerprints only) under `tests/fixtures/` when the live shape matters; fabricate clearly labelled fixtures only for shapes the account cannot produce today.
3. Add tests for `fresh` / `low` / `exhausted` / `unknown` on that candidate path, and that another bucket's exhaustion does not flip an unrelated candidate.

```sh
node scripts/orca-usage.mjs status                       # collector health, last success, current usage; reads nothing new
node scripts/orca-usage.mjs refresh                      # take one reading now
node scripts/orca-usage.mjs readings --limit 50          # raw readings, newest first
node scripts/orca-usage.mjs delete --id <n>              # delete one reading
node scripts/orca-usage.mjs delete --all                 # delete all history and backoff state
```

## Setup

Run once from the main checkout, after the code is on `main`:

```sh
scripts/install-usage-collector.sh           # installs, enables and restarts the service
scripts/install-usage-collector.sh --print   # shows the unit and changes nothing
```

The installer writes `~/.config/systemd/user/orca-usage-collector.service`, which runs the scripts in place, so a worktree is refused. It records the current `node`, `codex` and (when present) `agy` paths: rerun it after changing Node version or moving `codex`, and after pulling new collector code. A user service starts at boot only with lingering on (`loginctl show-user $USER --property=Linger`); the installer warns if it is off.

To remove it: `systemctl --user disable --now orca-usage-collector.service`, then delete the unit file. The history stays until you delete it.

## Status

`status` prints `collector` and, under `usage.<agent>`, the assessment plus the collector's view of that agent:

| Field | Meaning |
| --- | --- |
| `collector.state` | `running` (a heartbeat in the last three minutes), `stopped` or `never_started`. |
| `lastSuccessAt`, `lastAttemptAt` | The newest usable reading, and the newest attempt of any kind. |
| `consecutiveFailures`, `backingOff`, `nextPollAt` | The current failure run and when the next poll is due. |
| `lastFailure` | The newest failure's time, reason and detail. It stays after recovery. |

`status`, `freshness`, `observedAt`, `resetsAt`, `staleAfter`, `source`, `account` and `host` describe the reading itself. Service logs are in `journalctl --user -u orca-usage-collector.service`: one line per failure and one on recovery.

## Polling and backoff

- One read a minute, also while exhausted, so a reset shows within a minute. Only one collector runs per state directory.
- After a failure the wait is 2, 4, 8 and 16 minutes, then 30. HTTP 429 starts higher: 5, 10, 20, then 30. The first usable reading returns to every minute.
- The next poll time and failure count are stored, so a restart neither polls early nor forgets a backoff. After downtime it polls at once.

## Planning

`scripts/orca-recommend.mjs` takes a reading for each collected agent in the baseline before it plans, and needs neither the service nor the network to carry on: a provider or CLI failure is reported as `unavailable` with the failure reason; an unknown account or missing collector stays `unknown`. The one exception to refreshing is an active 429 backoff, when it uses the reading on file and `usage.refresh.reason` says `rate_limited_backoff`.

`usageByAgent` holds the agent-level summary for each collected agent, and `usage` the report for the chosen worker. `usageForPlanning` also builds `usageByCandidate` keyed `agent/model` for every row in `docs/agents/models.md`, using each provider's `assessCandidate` (same vocabulary, plus `buckets: [{ id, label, usedPercent, resetsAt }]` for the windows that govern that model). A reading stays current through a failed poll until it expires after 30 minutes or at a passed reset. A login problem (`unknown_account`, `account_mismatch`) ends it at once, because the last reading may be another account's. OpenCode is the exception: a failed gateway probe immediately supersedes a successful reading. Its unlimited bucket has no percentage windows and expires at its configured access deadline.

Each candidate is judged from **its** assessment (`fresh`, `low`, `exhausted`, `stale`, `unavailable` or `unknown`), not from another model's bucket on the same agent. `exhausted` moves only that candidate to `rejected`, with the bucket's reset in the reason; `low` warns only that candidate; only `fresh` and `low` have `capacityConfirmed: true`. Recommendation reasons name the bucket and percent (for example `antigravity/gemini-3.8-flash-high: Gemini Models weekly 8.7% used`, `cursor/auto: Cursor Models 25.3% used`). Cursor's agent summary follows Cursor Models when Other Models is exhausted, and still mentions Other Models separately. `unavailable` and `unknown` both leave capacity unconfirmed; the planner text for `unavailable` is `provider data unavailable (<reason>)`. An override onto exhausted usage is refused (`override-refused`); `orca-recommend.mjs` prints the override model's usage reading on stderr. Single-task `orca-recommend.mjs` keeps equivalent alternatives in table order; wave-level balancing across tasks, shared allowances and concurrency is `scripts/orca-plan.mjs` (see `docs/agents/wave-planner.md`).

## Stored data

History is a SQLite database, `usage.sqlite`, in `ORCA_USAGE_STATE_DIR`, else `$XDG_STATE_HOME/orca-usage`, else `~/.local/state/orca-usage`. The directory is `0700` and the file `0600`. It is outside the repository, so backups of `data/` do not cover it.

- Every attempt is one row in `readings`, failures included, and is never pruned. A year of minutely readings is about 300 MB.
- Credentials are excluded twice: the reader copies only the fields it needs, and the store drops keys that name credentials or identity and scrubs every string before writing.
- `delete --all` also clears the backoff state, so the collector polls at once.

## Recovery

| What `status` shows | What to do |
| --- | --- |
| `collector.state` is `stopped` or `never_started` | `systemctl --user status orca-usage-collector.service`, then `journalctl --user -u orca-usage-collector.service -n 50`. Run the installer if the unit is missing. |
| `lastFailure.reason` is `not_signed_in` or `auth_required` (Codex) | Run `codex login` on the host. Polling resumes by itself at the next attempt. |
| Claude `not_logged_in` / `credentials_expired` | Sign in with Claude Code on the host (`claude` auth). |
| Cursor `unknown_account` / auth missing | Sign in with the Cursor CLI / IDE on the host so `~/.cursor/auth.json` exists. |
| Antigravity login missing | Sign in with `agy` on the host. |
| `cli_not_found` | The named CLI moved. Rerun the installer after fixing PATH (`codex`, and ensure `agy` / Cursor / Claude Code stay reachable for their readers). |
| `cli_error` after a Codex update | Run `node scripts/codex-usage.mjs` and compare with `docs/agents/codex-usage.md`. A removed feature flag or changed protocol appears here. |
| `rate_limited` | Wait: the backoff recovers by itself. Do not lower it by hand. |
| The database is corrupt | Stop the service, move `usage.sqlite` aside and start it again. History restarts empty. |

## Verification

On 2026-10-30, `orca-usage.mjs run` ran on host `andi` for 2.5 hours as a transient `systemd-run --user` unit, on isolated state and with the installed unit's PATH and without a terminal. It took 150 polls 60 to 61 seconds apart with no failures, carried on while the account was exhausted, and read `available` 43 seconds after the 5h reset. `systemctl --user stop` ended it cleanly, and a new unit on the same state kept all 151 readings. `orca-recommend.mjs` then reported that account as `fresh`, with its source, times and collector status.

Not verified live:

- Starting at boot. `systemd-analyze --user verify` accepts the rendered unit and lingering is on, but no reboot was tested and the service is not installed until `scripts/install-usage-collector.sh` runs on `main`.
- Backoff and recovery from a failed read. The live run had no failures, so these are covered by tests with a fake clock and provider, and by failure replies from the real `codex` binary. No real 429 has been seen.
