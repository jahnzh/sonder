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
- `0` — Observation obtained or evaluated (`status` is `ok`, `low`, `exhausted`, or `stale`).
- `1` — Account unknown (`unknown_account`), account mismatched (`account_mismatch`), or usage data unavailable (`unavailable`).
- `2` — Invalid CLI flags.

Programmatic exports (`scripts/cursor-usage.mjs`, typed in `scripts/cursor-usage.d.mts`):
- `readCursorUsage(options)`
- `evaluateCursorObservation(observation, options)`
- `resolveCursorCredentialPaths(options)`
- `formatCursorUsageText(observation)`
- `redactSecrets(text, knownSecrets)`

## Verified read-only source

Cursor's Agent CLI (`agent`, verified on `2026.10.22-27dcf5f`) does not expose a non-interactive `--usage` CLI flag, but its interactive `/usage` view reads unary Connect-RPC JSON endpoints on `https://api2.cursor.sh/aiserver.v1.DashboardService` (all marked idempotent/no-side-effects in the CLI):

- `GetMe` — resolves the authenticated user (`userId`, `email`, `teamId`, `isEnterpriseUser`).
- `GetCurrentPeriodUsage` — returns `billingCycleStart`, `billingCycleEnd`, `planUsage` (`totalPercentUsed`, `autoPercentUsed`, `apiPercentUsed`, `includedSpend`, `bonusSpend`, `totalSpend`, `limit`), `spendLimitUsage`, and `autoBucketModels`.
- `GetPlanInfo` — optional enrichment returning `planName` (`Pro`, `Pro+`, `Ultra`, etc.), `price`, `includedUsagePeriod` (`MONTHLY` or `WEEKLY`), `billingCycleEnd`, and `includedUsageResetsAt`.
- `GetHardLimit` — optional enrichment returning personal/team On-Demand spend cap (`hardLimit` in USD, `noUsageBasedAllowed`, `onDemandSpendDisabledByOrganization`).
- `GetMonthlyBillingCycle` and `GetAggregatedUsageEvents` — read-only fallback used only when `planUsage` is absent and `GetMe.isEnterpriseUser` is `true`.

## Supported account and host scope

- **Single active Cursor CLI account per target host**: resolves credentials read-only in the same order as Cursor CLI:
  1. `CURSOR_AUTH_TOKEN` environment variable.
  2. Cursor CLI `auth.json` (`${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` on Linux, `~/.cursor/auth.json` on macOS, `%APPDATA%\Cursor\auth.json` on Windows).
  3. `CURSOR_API_KEY` environment variable or `apiKey` in `auth.json`, exchanged **in memory only** via `POST /auth/exchange_user_api_key` when no valid session JWT is present (never written back to `auth.json`).
- **Team scoping**: reads `authInfo.activeTeamId` read-only from `${CURSOR_CONFIG_DIR:-~/.cursor}/cli-config.json` (or `$XDG_CONFIG_HOME/cursor/cli-config.json`) and passes `x-cursor-team-id` and `GetMe({ teamId })` when active.
- **Host mapping**: `--host local` (default) inspects the local Orca host. Any non-local `--host <selector>` without an explicit entry in `--host-map` (or `CURSOR_USAGE_HOST_MAP`) returns `status: "unknown_account"` (`reason: "unknown_host_mapping"`) so a remote worker host is never planned against the local machine's Cursor quota.
- **Account verification**: `--expect-email`, `--expect-user-id`, `--expect-team-id`, or `hostMap[host].expectedAccount` checks `GetMe` before trusting quota; mismatches return `status: "account_mismatch"`.
- **Credential exclusion**: bearer tokens, refresh tokens, and API keys are never stored in returned observations, CLI output, or error objects, and error strings are scrubbed by `redactSecrets`.

## Provider-specific windows, resets, and statuses

Standard plans (`Pro`, `Pro+`, `Ultra`, `Teams`) return four provider-specific windows for the active billing period:

| Window ID | Cursor UI label | Meaning |
| --- | --- | --- |
| `included_total` | `Included` | Blended percentage used across the subscription's included allowance (`totalPercentUsed`). |
| `included_auto` | `Auto` (`Cursor Models` in Orca) | Included percentage used for `auto` and models listed in `autoBucketModels` (including verified repo models `auto` and `composer-2.5`). |
| `included_api` | `API` (`Other Models` in Orca) | Included percentage used for named third-party API models outside `autoBucketModels`. Can be `100%` exhausted while `included_auto` still has capacity. |
| `on_demand` | `On-Demand` | Paid usage-based spend window (`mode`: `fixed`, `unlimited`, `disabled`, or `unavailable`), reporting cent/dollar spend, limit, remaining budget, and percentage when `fixed`. |

Enterprise accounts without `planUsage` return `enterprise_spend` (`kind: "cumulative_spend"`), reporting current-cycle and comparable previous-period spend in cents/dollars.

Reset and freshness rules:
- `reset.primaryResetAt` uses `includedUsageResetsAt` when an earlier weekly reset is reported, otherwise `billingCycleEnd`.
- Observations expire (`status: "stale"`, `usableForPlanning: false`) when `evaluatedAtMs - observedAtMs > 30 minutes` (`staleReason: "max_age_exceeded"`) or when `evaluatedAtMs >= reset.primaryResetAtMs` (`staleReason: "reset_passed"`).

Distinct top-level statuses (`usableForPlanning` is `true` only for `ok` and `low`):
- `ok` — fresh reading with normal remaining capacity in the evaluated allowance.
- `low` — fresh reading at or below the low-capacity remaining threshold (default `15%` remaining).
- `exhausted` — fresh reading where the applicable included allowance is `>= 100%` used (unless `--allow-on-demand` is explicitly enabled and `on_demand` has remaining capacity).
- `stale` — observation is older than 30 minutes or its reported reset timestamp has passed (`priorStatus` preserves the pre-staleness capacity status).
- `unknown_account` — missing credentials, expired session JWT, HTTP 401/403 (`unauthenticated`), unidentified `GetMe`, or unmapped non-local `--host`.
- `account_mismatch` — active account on the host does not match `expectedAccount`.
- `unavailable` — network error, HTTP 5xx, HTTP 429 / `resource_exhausted` lookup rate limit (`error.rateLimited: true`, `error.retryAfterMs`), malformed response, or plan without CLI usage support (`plan_usage_unavailable`).

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

Model-scoped checks on the same live reading:
- `--model composer-2.5` → `bucket: "included_auto"`, `status: "ok"`, `usableForPlanning: true`.
- `--model auto` → `bucket: "included_auto"`, `status: "ok"`, `usableForPlanning: true`.
- `--model claude-sonnet-4-5` → `bucket: "included_api"`, `status: "exhausted"`, `usableForPlanning: false` (unless `--allow-on-demand` is passed).

## Limitations

- **Internal Cursor CLI RPC contract**: `aiserver.v1.DashboardService` is Cursor's first-party CLI/IDE Connect-RPC service rather than a versioned public REST API; field changes in future Cursor releases can trigger `status: "unavailable"` (`malformed_response`).
- **Single active account per host**: Cursor CLI stores one active login in `auth.json` per user profile; multi-account switching is out of scope (#103).
- **Remote host boundary**: Non-local hosts are not probed automatically unless mapped; unmapped hosts (including the WSL CI host, where work outside `~/sonder-replication/` is restricted) are reported as `unknown_account` (`unknown_host_mapping`).
- **Enterprise percentage cap**: Cursor Enterprise accounts without `planUsage` expose cumulative dollar spend (`enterprise_spend`) rather than a percentage quota cap.
- **Shared subscription attribution**: Concurrent Cursor workers on the same account share `included_auto` / `included_total` deltas; per-worker consumption cannot be inferred from account snapshots alone.
- **Paid On-Demand separation**: Paid On-Demand overage is reported in `windows` (`on_demand`) and excluded from `usableForPlanning` by default unless `--allow-on-demand` is explicitly requested.
