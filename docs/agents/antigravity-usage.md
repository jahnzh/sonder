# Antigravity usage reader

`node scripts/antigravity-usage.mjs` reads the Antigravity quota of the `agy` login on the host it runs on and prints one JSON observation. It is the Antigravity reader for usage-aware dispatch (#103, #109). It changes nothing: it runs two read-only `agy` print-mode commands and never prints or stores a token.

```sh
node scripts/antigravity-usage.mjs                                        # login under ~, agy on PATH
node scripts/antigravity-usage.mjs --expect-account <email or sha256:…>   # report a different login as account_mismatch
node scripts/antigravity-usage.mjs --home <dir> --agy <path>              # another home or agy binary
```

## Source

- Usage: `agy -p /usage --output-format json`. Antigravity CLI 1.4.11 answers `/usage`, `/quota` and `/credits` in print mode without starting an agent turn, spending quota or leaving a conversation (its changelog says so, and a run left `~/.gemini/antigravity-cli` unchanged). The command forces a fresh quota lookup from Google's backend. It is the CLI's own feature, so `source.official` is `true`, but the JSON payload has no published schema.
- Credits: `agy -p /credits --output-format json` gives the AI credit balance. If that call fails, `credits` is `null` and the usage reading stands.
- Account: `<home>/.gemini/antigravity-cli/antigravity-oauth-token`, the CLI's login file. The reader takes only `id_token_email` and `auth_method` from it. The email is reported as `scope.account`, a fingerprint (`sha256:` plus the first 16 hex digits of the SHA-256 of the lower-cased email), so observations never carry the address. The tokens in the file are not used by the reader; `agy` signs in with them itself.
- `agy` runs with `HOME=<home>` from the system temp directory, with stdin closed and a 45-second limit.

## Supported account

A Google account signed in to the Antigravity CLI (`agy`) on the host, with the file login above. `scope.authMethod` is the CLI's sign-in method (`consumer` for a personal Google account). The plan tier is not available in print mode. Orca starts Antigravity workers on this machine, so the reader runs here. To read another host's login, run the reader on that host. That has not been verified.

`--expect-account` takes the email or its fingerprint. Without it, `scope.account` still says which login was read.

## Windows

The provider groups models that share an allowance. Each group has one or more buckets, and each bucket becomes one window:

| Group (provider name) | Bucket `id` | `kind` | Meaning |
| --- | --- | --- | --- |
| Gemini Models (Gemini Flash, Gemini Pro) | `gemini-weekly`, `gemini-5h` | `weekly`, `five_hour` | The weekly allowance tied to the plan tier, and the five-hour limit that spreads global demand. |
| Claude and GPT models (Claude Opus, Claude Sonnet, GPT-OSS) | `3p-weekly`, `3p-5h` | `weekly`, `five_hour` | The same two windows for the third-party models. |
| Gemini 4 Argon | `gemini-argon-wtu-weekly` | `weekly` | On paid Pro plans Argon has its own weekly allowance. On Ultra it is part of the Gemini bucket. |

The table is what this account showed on 2026-10-30. Groups and buckets come from the response, so other plans can have others, and unknown `window` values pass through as the `kind`. Each window carries `id`, `kind`, `group`, `label`, `remainingFraction` (0 to 1, as the provider reports it), `usedPercent` (0 to 100, two decimals), `resetsAt` (ISO time or `null`) and `exhausted`. A window that has not been used reports a `resetsAt` one full window from now.

`groups[]` lists each group's `models` (from the provider's "Models within this group" text, or `null` when there is none), its `windowIds` and whether any of its windows is `exhausted`. Groups are separate allowances: an exhausted Gemini group does not block Claude models. Percentages describe Antigravity's own allowances and are not comparable with other providers' figures. Quota is consumed in proportion to token cost, so a percentage does not translate into a number of tasks.

`credits.remaining` is the AI credit balance. When a plan window is exhausted, requests can continue on credits while the balance lasts.

## Statuses

| `status` | `reason` | Meaning |
| --- | --- | --- |
| `available` | `null` | Windows were read and none is exhausted. |
| `exhausted` | `null` | At least one window has nothing left. `exhaustedWindows` lists their ids, and `groups[].exhausted` says which models are blocked. |
| `unknown_account` | `not_signed_in`, `account_not_identified` | There is no `agy` login under the home, or it does not name its account. `agy` is not run, because without a login it starts an interactive sign-in. |
| `account_mismatch` | `account_mismatch` | The login belongs to an account other than `--expect-account`. `agy` is not run. |
| `unavailable` | `credentials_unreadable`, `auth_required`, `cli_not_found`, `cli_error`, `timeout`, `malformed_response`, `no_usage_windows` | No usable reading. `auth_required` means `agy` asked to sign in again; the reader stops it at once. `cli_error` carries the CLI's message with emails and links removed. |

Every observation has `source`, `scope` (host, home, account fingerprint, sign-in method and expected account fingerprint), `observedAt` and `freshness`. `freshness.state` turns `stale` 30 minutes after `observedAt`, or once a window's `resetsAt` has passed. `assessFreshness(observation, now)` re-evaluates a stored observation.

## Limitations

- The JSON payload is unpublished. A shape change shows up as `malformed_response` or `no_usage_windows`, not as wrong numbers.
- Only the file login is supported. Business sign-in through `AGY_ADC_AUTH` keeps no login file and is reported as `not_signed_in`.
- An expired sign-in that `agy` cannot refresh is reported as `auth_required`. Sign in again by running `agy` interactively on the host.
- Readings about 30 seconds apart differed by up to one point in either direction while another Antigravity worker was running on the account. Remaining quota rose as well as fell, so treat a single reading as approximate and do not read a delta as one worker's consumption.
- Each reading starts `agy` twice, which takes about three seconds. The backend's rate limit for these lookups is not published, and rate-limit errors have not been observed, so they would show as `cli_error`.

## Verification

On 2026-10-30, the host `andi` was signed in to a personal Google account (`consumer`) in Antigravity CLI 1.4.11. A reader run at 09:15:28Z, the interactive `/usage` panel ("Models & Quota") at 09:15:48Z, and another reader run at 09:16:02Z showed:

| Window | Reader at 09:16:02Z | Panel at 09:15:48Z |
| --- | --- | --- |
| Gemini Models, weekly | 94.67% left, resets 2026-11-05T23:16:23Z | 94.67%, refreshes in 158h 0m |
| Gemini Models, five hours | 94.88% left, resets 2026-10-30T12:16:22Z | 94.88%, refreshes in 3h 0m |
| Claude and GPT models, both windows | 100% left | 100.00%, quota available |
| Gemini 4 Argon, weekly | 90.18% left, resets 2026-11-06T08:55:59Z | 90.18%, refreshes in 167h 40m |

An Antigravity worker was running on the account the whole time. The first reader run, 20 seconds before the panel, read 94.34%, 94.22% and 89.24% for the same windows. The fingerprint of the account the panel named matched `scope.account`. The reader left the CLI's conversations, history and login file unchanged, and no output contained the email or a token. On the same day, `--expect-account` with another email returned `account_mismatch`, and an empty `--home` returned `unknown_account` / `not_signed_in` without starting `agy`. Run by hand with an empty home, `agy -p /usage` printed a sign-in URL and waited 60 seconds, which is why the reader checks the login file first.
