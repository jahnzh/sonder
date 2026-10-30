# Claude usage reader

`node scripts/claude-usage.mjs` reads the Claude subscription usage of the Claude Code login on the host it runs on and prints one JSON observation. It is the Claude reader for usage-aware dispatch (#103, #107). It changes nothing: it makes two GET requests and never refreshes, stores or prints the token.

```sh
node scripts/claude-usage.mjs                                   # login in $CLAUDE_CONFIG_DIR, else ~/.claude
node scripts/claude-usage.mjs --expect-account <account-uuid>   # report a different login as account_mismatch
```

## Source

- Usage: `GET https://api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's `/usage` screen reads. It is undocumented, so `source.official` is `false`. Its shape can change without notice.
- Account: `GET https://api.anthropic.com/api/oauth/profile` names the account and organization that the token belongs to. The reader does not trust the cached identity in `.claude.json`.
- Both requests send the token from `<config dir>/.credentials.json` (`claudeAiOauth.accessToken`) with `anthropic-beta: oauth-2025-04-20`, as Claude Code 2.1.314 does.

## Supported account

A Claude.ai subscription (Pro or Max) logged in to Claude Code on the host, with credentials in the file store. `scope.plan` is the organization type, for example `claude_pro`, and `scope.rateLimitTier` is the provider's tier. Orca starts Claude workers on this machine, so the reader runs here. To read another host's login, run the reader on that host. That has not been verified.

## Windows

Windows come from the response's `limits[]` rows, which the provider calls its own usage rows. Each row is classified by `kind`, never by label:

| `kind` | Meaning |
| --- | --- |
| `session` | The rolling five-hour session allowance ("Current session"). |
| `weekly_all` | The seven-day allowance shared by all models ("Current week (all models)"). |
| `weekly_scoped` | A seven-day allowance for one model or surface. `scope.model` or `scope.surface` names it. |

Other kinds pass through unchanged. If `limits[]` is missing or empty, the reader falls back to the older named fields: `five_hour`, `seven_day`, `seven_day_opus` and `seven_day_sonnet`. Each window carries `usedPercent` (0 to 100), `resetsAt` (ISO time or `null`), the provider's `severity` (`normal`, `warning` or `critical`) and `active`, which marks the row the provider shows as its headline. Percentages describe Claude's own allowances and are not comparable with other providers' figures.

`extraUsage` reports whether usage credits are on and whether their spend limit is reached. When credits are on, a full plan window may still allow work, billed as credits.

## Statuses

| `status` | `reason` | Meaning |
| --- | --- | --- |
| `available` | `null` | Windows were read and none is full. `critical` severity is a caution, not exhaustion. |
| `exhausted` | `null` | At least one window is at 100%. `exhaustedWindows` lists their kinds. |
| `unknown_account` | `not_logged_in`, `account_not_identified` | There is no subscription login, or the profile named no account. No windows are reported. |
| `account_mismatch` | `account_mismatch` | The login belongs to an account other than `--expect-account`. The usage endpoint is not called. |
| `unavailable` | `credentials_expired`, `credentials_unreadable`, `auth_rejected`, `rate_limited`, `provider_error`, `network_error`, `malformed_response`, `no_usage_windows` | No usable reading. `rate_limited` carries `retryAfterSeconds` when the provider sends it. |

Every observation has `source`, `scope` (host, config directory, account and organization ids, plan, tier and expected account), `observedAt` and `freshness`. `freshness.state` turns `stale` 30 minutes after `observedAt`, or once a window's `resetsAt` has passed. `assessFreshness(observation, now)` re-evaluates a stored observation.

## Limitations

- The endpoint is unofficial. A shape change shows up as `malformed_response` or `no_usage_windows`, not as wrong numbers.
- The access token lasts a few hours, and only Claude Code refreshes it. When Claude Code has not run on the host for that long, the reader reports `credentials_expired`. Refreshing it here would rotate the refresh token from under Claude Code.
- Logins that Claude Code keeps outside `.credentials.json` cannot be read. That includes the macOS keychain, API keys, `apiKeyHelper`, Bedrock and Vertex. The reader reports them as `not_logged_in`.
- Each reading makes two requests. The provider's rate limit for these endpoints is not published. Back off on `rate_limited`.
- The "What's contributing" breakdown and spend amounts are not read.

## Verification

On 2026-10-30, the host `andi` was logged in to a Claude Pro account. A reader run at 09:02:35Z, the `/usage` screen in Claude Code 2.1.314 at 09:03:01Z, and another reader run at 09:03:04Z showed:

| Window | Reader | `/usage` screen |
| --- | --- | --- |
| Current session | 22%, resets 2026-10-30T13:10:00Z | 21% (cached), resets 1:10pm (UTC) |
| Current week (all models) | 64%, resets 2026-11-04T16:00:00Z | 63% (cached), resets Nov 4, 4pm (UTC) |

The screen draws its cached last reply first and then refreshes. A longer capture, ending at 09:03:55Z, showed the refreshed screen at 22% and 64%. A reader run at 09:03:58Z read the same values. On the same day, `--expect-account` with another id returned `account_mismatch`, and an empty config directory returned `unknown_account` / `not_logged_in`. No output contained either token.
