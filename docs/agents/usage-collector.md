# Usage collector

`scripts/orca-usage.mjs` keeps a local history of provider usage and feeds `scripts/orca-recommend.mjs`. It starts with the machine as a systemd user service and polls every minute whether or not any orchestration is running. It collects Codex today (#106); the other agents stay `unknown` until their readers are added to `PROVIDERS`. For what a Codex reading means, see `docs/agents/codex-usage.md`.

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

The installer writes `~/.config/systemd/user/orca-usage-collector.service`, which runs the scripts in place, so a worktree is refused. It records the current `node` and `codex` paths: rerun it after changing Node version or moving `codex`, and after pulling new collector code. A user service starts at boot only with lingering on (`loginctl show-user $USER --property=Linger`); the installer warns if it is off.

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

`scripts/orca-recommend.mjs` takes a reading for each collected agent in the baseline before it plans, and needs neither the service nor the network to carry on: if the read fails, usage is reported as `unknown`. The one exception to refreshing is an active 429 backoff, when it uses the reading on file and `usage.refresh.reason` says `rate_limited_backoff`.

`usageByAgent` holds the report for each collected agent, and `usage` the report for the chosen worker. A reading stays current through a failed poll until it expires after 30 minutes or at a passed reset. A login problem (`unknown_account`, `account_mismatch`) ends it at once, because the last reading may be another account's.

Each candidate's `usage` is the assessment. `exhausted` moves it to `rejected`, with the reset in the reason; `low` adds `decision.warning`; only `fresh` and `low` have `capacityConfirmed: true`. An override onto exhausted usage goes through with a warning. Usage does not yet reorder candidates: `stale` and `unknown` candidates stay in table order, and balancing is #110.

## Stored data

History is a SQLite database, `usage.sqlite`, in `ORCA_USAGE_STATE_DIR`, else `$XDG_STATE_HOME/orca-usage`, else `~/.local/state/orca-usage`. The directory is `0700` and the file `0600`. It is outside the repository, so backups of `data/` do not cover it.

- Every attempt is one row in `readings`, failures included, and is never pruned. A year of minutely readings is about 300 MB.
- Credentials are excluded twice: the reader copies only the fields it needs, and the store drops keys that name credentials or identity and scrubs every string before writing.
- `delete --all` also clears the backoff state, so the collector polls at once.

## Recovery

| What `status` shows | What to do |
| --- | --- |
| `collector.state` is `stopped` or `never_started` | `systemctl --user status orca-usage-collector.service`, then `journalctl --user -u orca-usage-collector.service -n 50`. Run the installer if the unit is missing. |
| `lastFailure.reason` is `not_signed_in` or `auth_required` | Run `codex login` on the host. Polling resumes by itself at the next attempt. |
| `cli_not_found` | `codex` moved. Rerun the installer. |
| `cli_error` after a Codex update | Run `node scripts/codex-usage.mjs` and compare with `docs/agents/codex-usage.md`. A removed feature flag or changed protocol appears here. |
| `rate_limited` | Wait: the backoff recovers by itself. Do not lower it by hand. |
| The database is corrupt | Stop the service, move `usage.sqlite` aside and start it again. History restarts empty. |

## Verification

On 2026-10-30, `orca-usage.mjs run` ran on host `andi` for 2.5 hours as a transient `systemd-run --user` unit, on isolated state and with the installed unit's PATH and without a terminal. It took 150 polls 60 to 61 seconds apart with no failures, carried on while the account was exhausted, and read `available` 43 seconds after the 5h reset. `systemctl --user stop` ended it cleanly, and a new unit on the same state kept all 151 readings. `orca-recommend.mjs` then reported that account as `fresh`, with its source, times and collector status.

Not verified live:

- Starting at boot. `systemd-analyze --user verify` accepts the rendered unit and lingering is on, but no reboot was tested and the service is not installed until `scripts/install-usage-collector.sh` runs on `main`.
- Backoff and recovery from a failed read. The live run had no failures, so these are covered by tests with a fake clock and provider, and by failure replies from the real `codex` binary. No real 429 has been seen.
