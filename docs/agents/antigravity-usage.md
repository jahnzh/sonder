# Antigravity usage reader

`node scripts/antigravity-usage.mjs` reads the Antigravity quota of the `agy` login on the host it runs on and prints one JSON observation. It is the Antigravity reader for usage-aware dispatch (#103, #109). It changes nothing: it runs one read-only `agy` print-mode command and never prints or stores a token.

```sh
node scripts/antigravity-usage.mjs                                        # login under ~, agy on PATH
node scripts/antigravity-usage.mjs --host <hostname>                      # report non-local target hosts as unknown_account
node scripts/antigravity-usage.mjs --expect-account <email or sha256:…>   # report a different login as account_mismatch
node scripts/antigravity-usage.mjs --home <dir> --agy <path>              # another home or agy binary
```

## Source

- Usage: `agy -p /usage --output-format json`. Antigravity CLI 1.4.11 answers `/usage` in print mode without starting an agent turn, spending quota or leaving a conversation (its changelog says so, and a run left `~/.gemini/antigravity-cli` unchanged). The command forces a fresh quota lookup from Google's backend. It is the CLI's own feature, so `source.official` is `true`, but the JSON payload has no published schema.
- Account: `<home>/.gemini/antigravity-cli/antigravity-oauth-token`, the CLI's login file. The file must hold a non-empty OAuth access or refresh token and a valid `id_token_email`. Only `id_token_email` and `auth_method` are reported on `scope`, and only after `agy` succeeds (or when reporting `account_mismatch` against `--expect-account`), so failed or expired sign-ins never attribute an unverified file login. `scope.account` is a fingerprint (`sha256:` plus the first 16 hex digits of the SHA-256 of the lower-cased email), so observations never carry the address. The tokens in the file are not retained; `agy` signs in with them itself.
- `agy` runs with `HOME=<home>` and `AGY_ADC_AUTH` cleared from the system temp directory, with stdin closed and a 45-second limit. AI credit balances (`/credits`) are not polled, so each poll spawns one `agy` process and paid add-on credits are never conflated with included plan quota.

## Supported account

A Google account signed in to the Antigravity CLI (`agy`) on the host, with the file login above. `scope.authMethod` is the CLI's sign-in method (`consumer` for a personal Google account). The plan tier is not available in print mode. Orca starts Antigravity workers on this machine, so the reader runs here. It reads only the local host's login: when `--host <hostname>` or `readAntigravityUsage({ host })` / `readAntigravityUsage({ hostname })` names a host other than `os.hostname()`, the reader does not read local credentials as that host's and returns `status: "unknown_account"` (`reason: "host_not_local"`, `scope.home: null`, `scope.account: null`). To read another host's login, run the reader on that host. That has not been verified.

`--expect-account` takes the email or its fingerprint. Without it, `scope.account` still says which login was read once `/usage` succeeds.

## Windows

The provider groups models that share an allowance. Each group has one or more buckets, and each bucket becomes one window:

| Group (provider name) | Bucket `id` | `kind` | Meaning |
| --- | --- | --- | --- |
| Gemini Models (Gemini Flash, Gemini Pro) | `gemini-weekly`, `gemini-5h` | `weekly`, `five_hour` | The weekly allowance tied to the plan tier, and the five-hour limit that spreads global demand. |
| Claude and GPT models (Claude Opus, Claude Sonnet, GPT-OSS) | `3p-weekly`, `3p-5h` | `weekly`, `five_hour` | The same two windows for the third-party models. |
| Gemini 4 Argon | `gemini-argon-wtu-weekly` | `weekly` | On paid Pro plans Argon has its own weekly allowance. On Ultra it is part of the `Gemini Models` bucket. |

The owner UI may show Gemini 4 Argon twice (a title row and a "Weekly" row with the same percent and reset). Raw `agy -p /usage` still has one Argon weekly window; that is not a global weekly cap and does not bind Gemini Models or Claude/GPT groups. `assessCandidateUsage` judges only the candidate's group windows (worst window wins when weekly and 5-hour both apply) and never treats Argon exhaustion as Flash exhaustion.

The table is what this account showed on 2026-10-30. Groups and buckets come from the response, so other plans can have others, and unknown `window` values pass through as the `kind`. Each window carries `id`, `kind`, `group`, `label`, `remainingFraction` (0 to 1, as the provider reports it), `usedPercent` (0 to 100, two decimals), `resetsAt` (ISO time or `null`) and `exhausted`. A window that has not been used reports a `resetsAt` one full window from now.

`groups[]` lists each group's `models` (from the provider's `"Models within this group:"` text, or resolved from a model-named group such as `"Gemini 4 Argon"`, or `null` when unrecognised), `modelIds` (the CLI model IDs in those families, including `gemini-3.8-flash-high` and `gemini-4-argon-high` from `docs/agents/models.md`), `appliesTo` (`"group"` when every listed model maps to a recognised family with reported windows, `"unknown"` otherwise), `windowIds` and `exhausted`. When an Ultra response includes `Gemini 4 Argon` in `Gemini Models` (either in `"Models within this group:"` or by reporting `Gemini 4 Argon` with no separate bucket and its shared-bucket description), both Flash and Argon map to the shared `Gemini Models` windows. `applicableWindows(observation, { model })` returns `{ family, groups, windowIds, windows }` for a candidate model (or `null` when unmapped or unrecognised) so callers can see which active and proposed workers share an allowance.

Groups are separate allowances unless shared on Ultra: an exhausted Gemini group on Pro does not block Claude or Argon models. Percentages describe Antigravity's own allowances and are not comparable with other providers' figures. Quota is consumed in proportion to token cost, so a percentage does not translate into a number of tasks.

## Statuses

| `status` | `reason` | Meaning |
| --- | --- | --- |
| `available` | `null` | Windows were read, all reported resets are in the future, and no window is exhausted. |
| `limited` | `null` | At least one window is exhausted, while other allowance groups remain available (or an unrecognised group is exhausted). `exhaustedWindows` lists exhausted bucket ids, and `candidateAvailability` decides per model. |
| `exhausted` | `null` | Every reported allowance group is recognised and has at least one exhausted window. |
| `stale` | `reset_passed` | Windows were read, but at least one reported `resetsAt` had already passed at `observedAt`. |
| `unknown_account` | `not_signed_in`, `account_not_identified`, `host_not_local` | There is no non-empty `agy` login under `home`, the login file does not name its account, `AGY_ADC_AUTH` overrides the file login, or the requested target host is not this host (local credentials are not read). `agy` is not run. |
| `account_mismatch` | `account_mismatch` | The login belongs to an account other than `--expect-account`. `agy` is not run. |
| `unavailable` | `credentials_unreadable`, `auth_required`, `cli_not_found`, `cli_error`, `timeout`, `malformed_response`, `no_usage_windows` | No usable reading. `scope.account` remains `null`. `auth_required` means `agy` asked to sign in again; the reader stops it at once. `cli_error` redacts links, emails, Bearer/Basic headers, OAuth tokens (`ya29.*`, `1//*`), API keys, JWTs, credential key/value pairs and login tokens from CLI error payloads and stderr. |

## Candidate availability

`candidateAvailability(observation, { model }, now?)` answers for one worker candidate, for example `{ model: "gemini-4-argon-high" }` or `{ model: "gemini-3.8-flash-high" }`. Candidate models match recognised Antigravity model families (`Gemini Flash`, `Gemini Pro`, `Gemini 4 Argon`, `Claude Opus`, `Claude Sonnet`, `Claude Haiku`, `GPT-OSS`); qualified, blank, omitted, unmapped or unrecognised scopes cannot be excluded and yield `unknown`. When `now` is omitted, freshness is re-evaluated against the current time rather than trusting `observation.freshness`.

| Result | Meaning |
| --- | --- |
| `exhausted` | An allowance window mapped to this candidate has nothing left. |
| `available` | The candidate maps to reported allowance windows with remaining capacity, and every exhausted group in the observation belongs to a known disjoint model family. |
| `unknown` | The reading is unusable (`unavailable`, `unknown_account`, `account_mismatch`) or is stale at `now` (defaulting to current time), `model` is omitted, blank, qualified, unmapped or unrecognised, or an exhausted group's scope is unrecognised. Never treat it as available. |

Every observation has `source`, `scope` (host, home or `null` when non-local, account fingerprint, sign-in method and expected account fingerprint), `observedAt` and `freshness`. `freshness.state` is `fresh` for a current reading, turns `stale` 30 minutes after `observedAt` or once a window's `resetsAt` has passed, and is `unknown` (`staleAfter: null`) when no usage windows were read. `assessFreshness(observation, now)` re-evaluates a stored observation.

## Limitations

- The JSON payload is unpublished. A shape change shows up as `malformed_response` or `no_usage_windows`, not as wrong numbers.
- Only the file login on the local host is supported. Business sign-in through `AGY_ADC_AUTH` overrides the file login and is reported as `unknown_account` (`account_not_identified`), and a missing or empty login file is reported as `not_signed_in`.
- An expired sign-in that `agy` cannot refresh is reported as `auth_required` without attributing `scope.account`. Sign in again by running `agy` interactively on the host.
- Readings about 30 seconds apart differed by up to one point in either direction while another Antigravity worker was running on the account. Remaining quota rose as well as fell, so treat a single reading as approximate and do not read a delta as one worker's consumption.
- Each reading starts `agy` once, which takes about one to two seconds. The backend's rate limit for these lookups is not published, and rate-limit errors have not been observed, so they would show as `cli_error`.

## Verification

On 2026-10-30, the host `andi` was signed in to a personal Google account (`consumer`) in Antigravity CLI 1.4.11. A reader run at 09:15:28Z, the interactive `/usage` panel ("Models & Quota") at 09:15:48Z, and another reader run at 09:16:02Z showed:

| Window | Reader at 09:16:02Z | Panel at 09:15:48Z |
| --- | --- | --- |
| Gemini Models, weekly | 94.67% left, resets 2026-11-05T23:16:23Z | 94.67%, refreshes in 158h 0m |
| Gemini Models, five hours | 94.88% left, resets 2026-10-30T12:16:22Z | 94.88%, refreshes in 3h 0m |
| Claude and GPT models, both windows | 100% left | 100.00%, quota available |
| Gemini 4 Argon, weekly | 90.18% left, resets 2026-11-06T08:55:59Z | 90.18%, refreshes in 167h 40m |

An Antigravity worker was running on the account the whole time. The first reader run, 20 seconds before the panel, read 94.34%, 94.22% and 89.24% for the same windows. The fingerprint of the account the panel named matched `scope.account`. The reader left the CLI's conversations, history and login file unchanged, and no output contained the email or a token. On the same day, `--expect-account` with another email returned `account_mismatch`, and an empty `--home` returned `unknown_account` / `not_signed_in` without starting `agy`. Run by hand with an empty home, `agy -p /usage` printed a sign-in URL and waited 60 seconds, which is why the reader checks the login file first.
