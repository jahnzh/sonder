# Claude usage reader

`node scripts/claude-usage.mjs` reads the Claude subscription usage of the Claude Code login on the host it runs on and prints one JSON observation. It is the Claude reader for usage-aware dispatch (#103, #107). It changes nothing: it makes two GET requests and never refreshes, stores or prints the token.

```sh
node scripts/claude-usage.mjs                                   # login in $CLAUDE_CONFIG_DIR, else ~/.claude
node scripts/claude-usage.mjs --host <hostname>                 # report non-local target hosts as unknown_account
node scripts/claude-usage.mjs --expect-account <account-uuid>   # report a different login as account_mismatch
```

## Source

- Usage: `GET https://api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's `/usage` screen reads. It is undocumented, so `source.official` is `false`. Its shape can change without notice.
- Account: `GET https://api.anthropic.com/api/oauth/profile` names the account and organization that the token belongs to. The reader does not trust the cached identity in `.claude.json`.
- Both requests send the token from `<config dir>/.credentials.json` (`claudeAiOauth.accessToken`) with `anthropic-beta: oauth-2025-04-20`, as Claude Code 2.1.314 does.

## Supported account

A Claude.ai subscription (Pro or Max) logged in to Claude Code on the host, with credentials in the file store. `scope.plan` is the organization type, for example `claude_pro`, and `scope.rateLimitTier` is the provider's tier. Orca starts Claude workers on this machine, so the reader runs here. It reads only the local host's login: when `--host <hostname>` or `readClaudeUsage({ hostname })` names a host other than `os.hostname()`, the reader does not read local credentials as that host's and returns `status: "unknown_account"` (`reason: "host_not_local"`, `scope.configDir: null`). To read another host's login, run the reader on that host. That has not been verified.

## Windows

Windows come from the response's `limits[]` rows, which the provider calls its own usage rows. Each row is classified by `kind`, never by label:

| `kind` | Meaning |
| --- | --- |
| `session` | The rolling five-hour session allowance ("Current session"). |
| `weekly_all` | The seven-day allowance shared by all models ("Current week (all models)"). |
| `weekly_scoped` | A seven-day allowance for one model or surface. `scope.model` or `scope.surface` names it. |

Other kinds pass through unchanged. If `limits[]` is missing or empty, the reader falls back to the older named fields: `five_hour`, `seven_day`, `seven_day_oauth_apps` (scoped to surface `OAuth apps`), `seven_day_opus` and `seven_day_sonnet`. Each window carries `appliesTo` (`all` for `session` and `weekly_all`, `scoped` when `scope` names a non-empty model or surface, `unknown` for any other kind or a blank or missing scope), `usedPercent` (0 to 100), `resetsAt` (ISO time or `null`), the provider's `severity` (`normal`, `warning` or `critical`) and `active`, which marks the row the provider shows as its headline. Percentages describe Claude's own allowances and are not comparable with other providers' figures.

`extraUsage` reports whether usage credits are on and whether their spend limit is reached. When credits are on, a full plan window may still allow work, billed as credits.

## Statuses

| `status` | `reason` | Meaning |
| --- | --- | --- |
| `available` | `null` | Windows were read and none is full. `critical` severity is a caution, not exhaustion. |
| `limited` | `null` | Only windows scoped to a model or surface, or of an unrecognised kind, are at 100%. The shared allowance remains, so other models may still run. Use `candidateAvailability` to decide for a candidate. |
| `exhausted` | `null` | A shared window (`appliesTo: "all"`: the session or the all-models week) is at 100%. Every model is blocked. |
| `unknown_account` | `not_logged_in`, `account_not_identified`, `host_not_local` | There is no subscription login, the profile named no account, or the requested target host is not this host (local credentials are not read). No windows are reported. |
| `account_mismatch` | `account_mismatch` | The login belongs to an account other than `--expect-account`. The usage endpoint is not called. |
| `unavailable` | `credentials_expired`, `credentials_unreadable`, `auth_rejected`, `rate_limited`, `provider_error`, `network_error`, `malformed_response`, `no_usage_windows` | No usable reading. `rate_limited` carries `retryAfterSeconds` only when the provider sends a non-negative numeric `Retry-After` header. |

`exhaustedWindows` lists every window at 100% as `{ kind, scope, appliesTo }`.

## Candidate availability

`candidateAvailability(observation, { model, surface }, now?)` answers for one worker candidate, for example `{ model: "claude-sonnet-5-5" }`. Recognized bare model scopes (`Opus`, `Sonnet`, `Haiku`) match Claude candidate models by family, and known distinct product surfaces (`Claude Code`, `Claude Design`) are treated as mutually exclusive; an exact normalized match on model or surface also counts as a match. Qualified, umbrella or unrecognised scopes (such as `Opus only`, `Claude 5.5 Opus`, surface `OAuth apps`, or a blank `display_name`) cannot be excluded and yield `unknown`. When `now` is omitted, freshness is re-evaluated against the current time rather than trusting `observation.freshness`.

| Result | Meaning |
| --- | --- |
| `exhausted` | A shared window, or a window scoped to this candidate, is full. |
| `available` | Nothing applying to this candidate is full, and every full scoped window belongs to a known disjoint model or surface. |
| `unknown` | The reading is not usable (`unavailable`, `unknown_account`, `account_mismatch`) or is stale at `now` (defaulting to current time), or a full window is scoped to a model or surface the candidate does not state, or its scope is qualified, blank or unrecognised. Never treat it as available. |

A model with no window in the response is treated as unlimited by that window; the reader cannot see allowances the provider does not report.

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
