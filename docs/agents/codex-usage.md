# Codex usage reader

`node scripts/codex-usage.mjs` reads the Codex usage of the login on the host it runs on and prints one JSON observation with its assessment. It is the Codex reader for usage-aware dispatch (#103, #106); `scripts/orca-usage.mjs` runs it every minute. It starts no thread, spends no quota and never handles a token.

```sh
node scripts/codex-usage.mjs                                        # the login Codex itself would use
node scripts/codex-usage.mjs --host <hostname>                      # report another host as unknown_account
node scripts/codex-usage.mjs --expect-account <email or sha256:…>   # report a different login as account_mismatch
node scripts/codex-usage.mjs --codex <path> --codex-home <dir>      # another binary or Codex home
```

## Source

- One short `codex app-server --disable plugins --disable apps --disable plugin_discovery_prefetch` process over stdio, asked `initialize`, `account/read` and `account/rateLimits/read` (with `excludeResetCreditDetails`, the option Codex offers for background polls). It is Codex's own protocol, so `source.official` is `true`, but `app-server` is marked experimental. `codex app-server generate-json-schema --out <dir>` prints the current schema.
- The three disabled features are not optional. Without them every start also syncs plugins: six more backend calls and rewritten files under `~/.codex/plugins/cache`. With them the only backend calls are `wham/accounts/check` and `wham/usage`.
- Codex holds the login, so the reader never opens `auth.json`. A token refresh, when one is due, is Codex's normal one.
- Each read takes about 0.6 seconds. The limit is 30 seconds, or 15 before planning.

## Supported account

A ChatGPT account signed in to the Codex CLI on the host. Workers use the same one: Orca's `~/.config/orca/codex-pane-accounts.json` maps Codex panes to `selectionKey: host` and `homeRoute: real-home`, which is `~/.codex`. A pane routed to another Orca account would not match this reading.

`scope.account` is a fingerprint (`sha256:` plus the first 16 hex digits of the SHA-256 of the lower-cased email). `scope.plan` is the plan the response names and `scope.authMethod` is `chatgpt`. The collector drops `codexHome` before storing a reading (path is not retained). The email, the account id and the upsell banner in the response are not retained. `raw` is a copy of the rate-limit figures only.

Only this host's login is read. Another `--host` returns `unknown_account` / `host_not_local` without starting `codex`; to read another host, run the reader there, which has not been verified.

## Windows

`windows[]` has one entry per reported window. On this Plus account on 2026-10-30, the only bucket was `codex`:

| `id` | `kind` | Provider display | Meaning |
| --- | --- | --- | --- |
| `codex-5h` | `five_hour` | 5h limit | The 300-minute window. |
| `codex-weekly` | `weekly` | Weekly limit | The 10080-minute window. |

Each window has `id`, `limitId`, `kind`, `label`, `durationMinutes`, `usedPercent` (a whole number, as the provider reports it), `remainingPercent`, `resetsAt` (ISO time or `null`) and `exhausted`. Other durations pass through as `<minutes>m`. These percentages describe Codex's own allowance and are not comparable with another provider's.

## Statuses

| `status` | `reason` | Meaning |
| --- | --- | --- |
| `available` | `null` | Windows read, and the backend reports `ordinaryUsageAllowed: true`. |
| `exhausted` | `rate_limit_reached` or another `rateLimitReachedType`, `spend_control_reached`, `ordinary_usage_blocked` | The backend blocks included usage, or a window is at 100%. `exhaustedWindows` lists the windows, and can be empty when only the backend's flag says so. |
| `unconfirmed` | `ordinary_usage_not_reported` | Windows read, but `ordinaryUsageAllowed` is `null`. Codex's schema says clients must not infer recovery from percentages or resets then, so it assesses as `unknown`. |
| `stale` | `reset_passed` | A window's `resetsAt` had already passed when it was read. |
| `unknown_account` | `not_signed_in`, `not_chatgpt_account`, `account_not_identified`, `host_not_local` | No login, an API key login (which has no plan usage), no email in `account/read`, or another host. |
| `account_mismatch` | `account_mismatch` | The login is not `--expect-account`. |
| `unavailable` | `rate_limited`, `auth_required`, `provider_error`, `provider_unreachable`, `malformed_response`, `no_usage_windows`, `cli_not_found`, `cli_error`, `timeout` | No usable reading, and `scope.account` stays `null`. `rate_limited` is HTTP 429, `auth_required` is 401 or 403 (run `codex login`), and `provider_error` is any other HTTP failure. `detail` is written by the reader or redacted, and never carries the upstream URL or body. |

## Assessment

`assessCodexUsage(observation, now)` re-evaluates a stored reading, so it is what callers use rather than `status`:

| Assessment | `capacityConfirmed` | Meaning |
| --- | --- | --- |
| `fresh` | yes | Current, with more than 10% left in every `codex` window. |
| `low` | yes | Current, with 10% or less left in a window. A caution level chosen by hand, not a measurement. |
| `exhausted` | no | Current, and `resetsAt` is when the blocking window resets. |
| `stale` | no | Over 30 minutes old, or a reported reset has passed. `reason` gives which, and the old figures. |
| `unavailable` | no | The provider or CLI could not be read (`rate_limited`, `auth_required`, `provider_error`, and the other unavailable observation reasons). Distinct from unknown: a failure was observed. |
| `unknown` | no | No usable reading for another reason (no reading yet, unknown account, unconfirmed ordinary usage). |

A confirmed reading is a snapshot of a shared allowance, not reserved capacity.

## Limitations

- `app-server` is experimental and its response has no stability promise. A change shows up as `malformed_response`, `no_usage_windows` or `cli_error`, not as wrong numbers. A renamed feature flag fails loudly as `cli_error`.
- Each read still writes Codex's own local logs (`logs_2.sqlite`) and touches its SQLite WAL files. `auth.json`, `config.toml`, `history.jsonl`, the session index and `sessions/` were unchanged across reads.
- `resetsAt` for an unused window is not a fixed time, as Verification shows.
- Agent-level `assessCodexUsage` interprets only the `codex` bucket. `assessCandidateUsage` resolves the candidate's limit id (`limitName` / `normalModelSlug` when a bucket declares a model, else `codex` for ordinary Codex models) and assesses only that bucket's windows. Extra limit ids with an unplaceable model return `unknown`, never `fresh`. No second limit id has been seen on this account; fixtures that include one are labelled fabricated.
- `individualLimit` is not read: it was `null` here, and a workspace spend limit is expected to show in `ordinaryUsageAllowed`. Credits are reported in `credits` and never count as capacity.
- The backend's rate limit for this endpoint is unpublished, and a one-minute poll has not triggered it. The 429 handling was tested against the real binary with a stubbed backend, not against a real 429, and the `Retry-After` header does not reach the client.
- HTTP failures are classified from the text of Codex's error message.

## Verification

All on 2026-10-30, on host `andi`, with `codex-cli 0.166.0`, signed in with a ChatGPT Plus account. The email `/status` named hashes to the reader's `scope.account` in both comparisons below.

With the 5h window used up, a reader run and the interactive `/status` panel showed:

| Window | Reader at 11:49:54Z | `/status` at 11:42Z |
| --- | --- | --- |
| 5h limit | 100% used, resets 2026-10-30T13:03:54Z | 0% left, resets 13:03 |
| Weekly limit | 64% used, resets 2026-11-04T11:06:09Z | 36% left, resets 11:06 on 4 Nov |
| Plan | `plus`, `ordinaryUsageAllowed: false` | Plus |

After the reset, reader runs either side of the panel showed:

| Window | Reader at 14:22:02Z and 14:22:22Z | `/status` between them |
| --- | --- | --- |
| 5h limit | 0% used, resets 19:22:03Z, then 19:22:23Z | 100% left, resets 19:22 |
| Weekly limit | 64% used, resets 2026-11-04T11:06:09Z | 36% left, resets 11:06 on 4 Nov |
| Plan | `plus`, `ordinaryUsageAllowed: true` | Plus |

The 5h window's reset moved with each read because that window was unused: an unused window reports a reset one full window from now.

The collector polled through the reset on isolated state. Its first poll after 13:03:54Z, at 13:04:37Z, read `available`. The 78 polls from then until 14:21Z all read 0% and 64% used, which shows reads spend no quota, at least with no worker running.

Failure shapes were captured from the real binary rather than assumed: `CODEX_HOME` pointing at an empty directory (no login), at an `apikey` `auth.json` (`not_chatgpt_account`), and at a throwaway login with `-c chatgpt_base_url=…` pointing at a local stub that answered 429, 500, 401 and invalid JSON, or at a closed port. Those replies are the fixtures in `tests/codex-fixture.mjs`.
