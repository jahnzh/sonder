# Cursor Usage Reader

`scripts/cursor-usage.mjs` obtains an automatic, read-only Cursor subscription usage observation on demand for a target worker host, without writing to Cursor configuration files or retaining credentials.

## Usage

```bash
# Human-readable coordinator summary for the local host
node scripts/cursor-usage.mjs

# Machine-readable JSON observation
node scripts/cursor-usage.mjs --json

# Check capacity for a specific verified Cursor model
node scripts/cursor-usage.mjs --model composer-2.5 --json
node scripts/cursor-usage.mjs --model auto --json

# Verify active account identity on the target host
node scripts/cursor-usage.mjs --expect-user-id 1234567 --json

# Re-evaluate freshness/staleness of a saved observation JSON snapshot
node scripts/cursor-usage.mjs --evaluate-file /path/to/observation.json --json
```

Exit codes:
- `0` — Observation obtained or evaluated (`status` is `ok`, `low`, `limited`, `exhausted`, `unknown`, or `stale`).
- `1` — Account unknown (`unknown_account`), account mismatched (`account_mismatch`), or usage data unavailable (`unavailable`).
- `2` — Invalid CLI flags.

Programmatic exports (`scripts/cursor-usage.mjs`, typed in `scripts/cursor-usage.d.mts`):
- `readCursorUsage(options)`
- `evaluateCursorObservation(observation, options)`
- `candidateAvailability(observation, candidate, now)`
- `resolveCursorCredentialPaths(options)`
- `formatCursorUsageText(observation)`
- `redactSecrets(text, knownSecrets)`

## Verified read-only source

Cursor's Agent CLI (`agent`, verified on `2026.10.22-27dcf5f`) does not expose a non-interactive `--usage` CLI flag, but its interactive `/usage` view reads unary Connect-RPC JSON endpoints on `https://api2.cursor.sh/aiserver.v1.DashboardService` (all marked idempotent/no-side-effects in the CLI):

- `GetMe` — resolves the authenticated user (`userId`, `email`, `teamId`, `isEnterpriseUser`).
- `GetCurrentPeriodUsage` — returns `billingCycleStart`, `billingCycleEnd`, `planUsage` (`totalPercentUsed`, `autoPercentUsed`, `apiPercentUsed`, `includedSpend`, `bonusSpend`, `totalSpend`, `limit`, `autoSpend`, `autoLimit`, `apiSpend`, `apiLimit`), `spendLimitUsage` (`individual*` and team `pooledLimit`/`pooledUsed`/`pooledRemaining`), and `autoBucketModels`.
- `GetPlanInfo` — optional enrichment returning `planName` (`Pro`, `Pro+`, `Ultra`, etc.), `price`, `includedUsagePeriod` (`MONTHLY` or `WEEKLY`), `billingCycleEnd`, and `includedUsageResetsAt`.
- `GetHardLimit` — optional enrichment returning personal/team spend caps (`hardLimit`, `hardLimitPerUser`, `perUserMonthlyLimitDollars` in USD, `2147483647` sentinel for unlimited, `noUsageBasedAllowed`, `onDemandSpendDisabledByOrganization`).
- `GetMonthlyBillingCycle` and `GetAggregatedUsageEvents` — read-only fallback used only when `planUsage` is absent and `GetMe.isEnterpriseUser` is `true`.

## Supported account and host scope

- **Single active Cursor CLI account on the local host**: resolves credentials read-only in the same order as Cursor CLI:
  1. `CURSOR_AUTH_TOKEN` environment variable (skipped when an explicit `--auth-file` / `authFilePath` is supplied).
  2. Cursor CLI `auth.json` (`${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` on Linux, `~/.cursor/auth.json` on macOS, `%APPDATA%\Cursor\auth.json` on Windows).
  3. `CURSOR_API_KEY` environment variable (when `--auth-file` is not explicitly overridden) or `apiKey` in `auth.json`, exchanged **in memory only** via `POST /auth/exchange_user_api_key` when no valid session JWT is present (never written back to `auth.json`).
  4. `refreshToken` in `auth.json` is intentionally **never** exchanged: Cursor's refresh flow rotates `(accessToken, refreshToken)` pairs and expects the caller to persist the rotated pair to `auth.json`. Exchanging `refreshToken` without writing `auth.json` would violate the read-only invariant or invalidate Cursor CLI's stored login, so an expired session JWT without an API key returns `status: "unknown_account"` (`reason: "expired_credentials"`).
- **Team scoping**: reads `authInfo.activeTeamId` read-only from `${CURSOR_CONFIG_DIR:-~/.cursor}/cli-config.json` (or `$XDG_CONFIG_HOME/cursor/cli-config.json`) unless `--auth-file` is passed without `--config-file`, and sends `x-cursor-team-id` and `GetMe({ teamId })` when active.
- **Local-only host boundary (`host_not_local`)**: `--host local` (default) or a `--host` matching `os.hostname()` inspects the local host. Any requested target host that is not the local host (or any `--host-map` entry targeting a non-local transport or foreign `hostname`) immediately returns `status: "unknown_account"`, `reason: "host_not_local"` **without** reading local credentials (`env`, `auth.json`, or `cli-config.json`) and never stamps a foreign hostname onto local credentials.
- **Endpoint scheme (`insecure_endpoint`)**: the bearer token is sent to `--endpoint`, a host-map `endpoint`, `CURSOR_API_ENDPOINT` or `CURSOR_API_BASE_URL`, so the resolved endpoint must be `https:`. Plain `http:` is accepted only for `127.0.0.1`, `::1` or `localhost` (local mocks). Anything else, including an unparseable URL, returns `status: "unavailable"`, `reason: "insecure_endpoint"` before credentials are read or any request is made; the message names only scheme and host, never the token.
- **Account verification**: `--expect-email`, `--expect-user-id`, `--expect-team-id`, or `hostMap[host].expectedAccount` checks `GetMe` directly (`--expect-team-id` compares against `GetMe.teamId`, never cached `cli-config.json` `activeTeamId`). Mismatches return `status: "account_mismatch"` and take precedence over `plan_usage_unavailable`.
- **Credential exclusion**: bearer tokens, refresh tokens, and API keys (including `CURSOR_API_KEY` when `CURSOR_AUTH_TOKEN` is also set) are never stored in returned observations, CLI stdout/stderr, or error objects, and all error paths are scrubbed by `redactSecrets`.

## Provider-specific windows, resets, and statuses

Standard plans (`Pro`, `Pro+`, `Ultra`, `Teams`) return up to four provider-specific windows for the active billing period (an empty `planUsage: {}` with no usable percentage windows returns `status: "unavailable"`, `reason: "malformed_response"`):

| Window ID | Cursor UI label | Scope (`appliesTo`) | Meaning |
| --- | --- | --- | --- |
| `included_total` | `Included` | `all` | Blended percentage used across the subscription's included allowance (`totalPercentUsed`). Emitted only when `totalPercentUsed` is reported (never fabricated from `includedSpend / limit`). |
| `included_auto` | `Auto` (`Cursor Models` in Orca) | `scoped` (or `unknown` if `autoBucketModels` omitted) | Included percentage used for `auto`, `default`, and models listed in `autoBucketModels` (including verified repo models `auto` and `composer-2.5`). |
| `included_api` | `API` (`Other Models` in Orca) | `scoped` (or `unknown` if `autoBucketModels` omitted) | Included percentage used for named third-party API models outside `autoBucketModels` (`apiSpend` / `apiLimit` when reported, else `null`). Can be `100%` exhausted while `included_auto` still has capacity. |
| `on_demand` | `On-Demand` | informational | Paid usage-based spend window (`mode`: `fixed`, `unlimited`, `disabled`, or `unavailable`), supporting both `user` limits and `team` `pooledLimit`/`pooledUsed`/`pooledRemaining` (a finite team `hardLimit` without pooled usage figures reports `mode: "unavailable"`). Never overrides exhausted included subscription quota. |

Enterprise accounts without `planUsage` return `enterprise_spend` (`kind: "cumulative_spend"`), reporting current-cycle and comparable previous-period spend in cents/dollars and consulting `GetHardLimit`. When `GetHardLimit` disables spend or current spend reaches a finite `hardLimit` / `hardLimitPerUser` / `perUserMonthlyLimitDollars`, it reports `disabled` or `exhausted`; when no verifiable remaining cap is available, it reports `status: "unknown"` (`usableForPlanning: false`) rather than `unlimited`.

Reset and freshness rules:
- `reset.primaryResetAt` uses `includedUsageResetsAt` when an earlier weekly reset is reported, otherwise `billingCycleEnd`.
- Observations expire (`status: "stale"`, `usableForPlanning: false`) when `observedAtMs` / `observedAt` is missing or invalid (`staleReason: "missing_observed_at"`), when `evaluatedAtMs - observedAtMs > 30 minutes` (`staleReason: "max_age_exceeded"`), or when `evaluatedAtMs >= reset.primaryResetAtMs` (`staleReason: "reset_passed"`).

Distinct top-level statuses (`usableForPlanning` is `true` only for `ok` and `low`):
- `ok` — fresh reading with normal remaining capacity across all applicable windows.
- `low` — fresh reading where an applicable window (or any included sub-window on an unscoped read) is at or below the low-capacity remaining threshold (default `15%` remaining).
- `limited` — fresh unscoped reading where a model-scoped bucket (`included_auto` or `included_api`) is `100%` exhausted while shared/other included capacity remains (`usableForPlanning: false`; inspect `candidateAvailability(observation, { model })` or `--model <id>` to plan eligible models).
- `exhausted` — fresh reading where a shared subscription window (`included_total` or capped `enterprise_spend`) or the evaluated model's bucket is `>= 100%` used.
- `unknown` — fresh reading whose remaining capacity cannot be verified for the requested scope (for example, `autoBucketModels` omitted when evaluating a non-`auto` model, blank/qualified model syntax, incomplete windows without `included_total`, or Enterprise spend without a verifiable cap).
- `stale` — observation has missing/invalid `observedAt`, is older than 30 minutes, or its reported reset timestamp has passed (`priorStatus` preserves the pre-staleness capacity status).
- `unknown_account` — non-local target host (`host_not_local`), missing credentials, expired session JWT (`expired_credentials`), HTTP 401/403 (`unauthenticated`), or unidentified `GetMe`.
- `account_mismatch` — active account on the host does not match `expectedAccount`.
- `unavailable` — network error, HTTP 5xx, HTTP 429 / `resource_exhausted` lookup rate limit (`error.rateLimited: true`, `error.retryAfterMs`), malformed response, or plan without CLI usage support (`plan_usage_unavailable`).

Candidate availability helper (`candidateAvailability(observation, { model, surface }, now)`):
- Returns `"exhausted"` when a shared window (`appliesTo: "all"`) or the candidate's verified model bucket is full.
- Returns `"available"` when the observation is fresh at `now` (defaulting to current wall-clock time) and every window applicable to the candidate has remaining capacity.
- Returns `"unknown"` when the observation is stale or unusable, when a scoped bucket is exhausted and `candidate.model` is omitted, or when the provider's or candidate's model/surface scope is blank, qualified, unmapped, or unrecognised (never `"available"`).

## Live verification against provider displays (2026-10-30)

Verified live on local Orca host `andi` (`orca host list`: sole configured worker host `local`) for the authenticated `Pro` (`$20/mo`) subscription against both Cursor Agent CLI's interactive `/usage` display (`2026.10.22-27dcf5f`) and Orca's live rate-limit readout (`orca account list --json` -> `result.rateLimits.cursor`):

| Field | `node scripts/cursor-usage.mjs --json` | Cursor CLI `/usage` display | Orca `rateLimits.cursor` |
| --- | --- | --- | --- |
| Plan | `Pro` (`$20/mo`), `monthly` | `Usage • Pro` | `planType: "pro"` |
| Billing cycle / reset | `2026-10-21T08:14:23.000Z` → `2026-11-21T08:14:23.000Z` (`Resets Nov 21`) | `Resets Nov 21` | `resetsAt: 1795248863000` (`Nov 21`) |
| `included_total` | `13.38%` (`displayPercentUsed: 13`, `status: "ok"`) | `Included: 13% used` | `monthly.usedPercent: 13.38%` |
| `included_auto` | `9.04%` (`displayPercentUsed: 9`, `status: "ok"`, includes `auto`, `composer-2.5`) | `Auto: 9% used` | `Cursor Models: 9.04%` |
| `included_api` | `100%` (`displayPercentUsed: 100`, `status: "exhausted"`) | `API: 100% used` | `Other Models: 100%` |
| `on_demand` | `fixed`, `$0 / $20` (`$20 remaining`, `0%`, `status: "ok"`) | `On-Demand: $0 / $20` (`$20 remaining`) | `On-demand: 0%` |

Unscoped and model-scoped checks on the same live reading:
- Unscoped (`node scripts/cursor-usage.mjs --json`) → `status: "limited"`, `reason: "scoped_quota_exhausted"`, `usableForPlanning: false` (because `included_api` is `100%` while `included_auto` is `9.04%`).
- `--model composer-2.5` → `bucket: "included_auto"`, `status: "ok"`, `usableForPlanning: true` (`candidateAvailability` → `"available"`).
- `--model auto` → `bucket: "included_auto"`, `status: "ok"`, `usableForPlanning: true` (`candidateAvailability` → `"available"`).
- `--model claude-sonnet-4-5` → `bucket: "included_api"`, `status: "exhausted"`, `usableForPlanning: false` (`candidateAvailability` → `"exhausted"`).

## Limitations

- **Internal Cursor CLI RPC contract**: `aiserver.v1.DashboardService` is Cursor's first-party CLI/IDE Connect-RPC service rather than a versioned public REST API; field changes in future Cursor releases can trigger `status: "unavailable"` (`malformed_response`).
- **Single active account per host**: Cursor CLI stores one active login in `auth.json` per user profile; multi-account switching is out of scope (#103), and `refreshToken` is never exchanged so `auth.json` and Cursor CLI's rotated token state remain untouched.
- **Local-only host boundary**: `scripts/cursor-usage.mjs` only reads credentials on the local host (`--host local` or matching `os.hostname()`). Non-local hosts (including the WSL CI host) return `status: "unknown_account"` (`reason: "host_not_local"`) without reading local credentials; remote inspection requires running the reader on that host itself.
- **Enterprise cap visibility**: Cursor Enterprise accounts without `planUsage` expose cumulative dollar spend (`enterprise_spend`); unless `GetHardLimit` proves exhaustion, disability, or an explicit per-user cap under an unlimited org pool, remaining capacity is reported as `status: "unknown"` (`usableForPlanning: false`).
- **Shared subscription attribution**: Concurrent Cursor workers on the same account share `included_auto` / `included_total` deltas; per-worker consumption cannot be inferred from account snapshots alone.
- **Paid On-Demand separation**: Paid On-Demand overage is reported in `windows` (`on_demand`) for visibility only and never makes an exhausted included subscription bucket `usableForPlanning: true`.
