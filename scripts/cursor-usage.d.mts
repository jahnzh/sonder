export type CursorUsageStatus =
  | "ok"
  | "low"
  | "limited"
  | "exhausted"
  | "unknown"
  | "stale"
  | "unknown_account"
  | "account_mismatch"
  | "unavailable";

export type CursorWindowStatus =
  | "ok"
  | "low"
  | "exhausted"
  | "disabled"
  | "unlimited"
  | "unknown"
  | "unavailable";

export type CursorAppliesTo = "all" | "scoped" | "unknown";

export type CursorCandidateAvailability = "available" | "exhausted" | "unknown";

export type CursorCredentialSource =
  | "env:CURSOR_AUTH_TOKEN"
  | "env:CURSOR_API_KEY"
  | "file:auth.json"
  | "file:auth.json(apiKey)"
  | "none";

export interface CursorExpectedAccount {
  email?: string;
  userId?: number;
  teamId?: number;
}

export interface CursorHostMappingEntry {
  transport?: "local";
  endpoint?: string;
  authFilePath?: string;
  configFilePath?: string;
  expectedAccount?: CursorExpectedAccount;
}

export interface CursorPercentageWindow {
  id: "included_total" | "included_auto" | "included_api";
  label: string;
  kind: "percentage_allowance";
  appliesTo: CursorAppliesTo;
  period: "monthly" | "weekly" | "unspecified";
  usedPercent: number;
  displayPercentUsed: number;
  remainingPercent: number;
  includedSpendCents: number | null;
  limitCents: number | null;
  bonusSpendCents: number | null;
  totalSpendCents: number | null;
  applicableModels?: string[];
  modelScopeKnown?: boolean;
  appliesToNamedModelsOutsideAutoBucket?: boolean;
  resetsAt: string | null;
  resetsAtMs: number | null;
  status: "ok" | "low" | "exhausted";
}

export interface CursorOnDemandWindow {
  id: "on_demand";
  label: string;
  kind: "spend_limit";
  period: "monthly" | "weekly" | "unspecified";
  mode: "fixed" | "unlimited" | "disabled" | "unavailable";
  scope: "personal" | "team-member" | null;
  usedCents: number;
  limitCents: number | null;
  remainingCents: number | null;
  usedDollars: number;
  limitDollars: number | null;
  remainingDollars: number | null;
  usedPercent: number | null;
  displayPercentUsed: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  resetsAtMs: number | null;
  status: CursorWindowStatus;
}

export interface CursorEnterpriseSpendWindow {
  id: "enterprise_spend";
  label: string;
  kind: "cumulative_spend";
  appliesTo: "all" | "unknown";
  period: "monthly";
  usedCents: number;
  usedDollars: number;
  limitCents: number | null;
  limitDollars: number | null;
  remainingCents: number | null;
  remainingDollars: number | null;
  previousPeriodCents: number | null;
  previousPeriodDollars: number | null;
  usedPercent: number | null;
  displayPercentUsed: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  resetsAtMs: number | null;
  status: "ok" | "low" | "exhausted" | "disabled" | "unlimited" | "unknown";
}

export type CursorUsageWindow =
  | CursorPercentageWindow
  | CursorOnDemandWindow
  | CursorEnterpriseSpendWindow;

export interface CursorUsageObservation {
  provider: "cursor";
  status: CursorUsageStatus;
  priorStatus: CursorUsageStatus | null;
  usableForPlanning: boolean;
  reason: string | null;
  source: {
    kind: "cursor-dashboard-rpc";
    transport: "local";
    endpoint: string;
    service: "aiserver.v1.DashboardService";
    methods: string[];
    credentialSource: CursorCredentialSource;
    readOnly: true;
  };
  scope: {
    host: {
      selector: string;
      transport: "local" | "unmapped";
      hostname: string | null;
      platform: string | null;
    };
    account: {
      known: boolean;
      verifiedMatch: boolean | null;
      userId: number | null;
      email: string | null;
      displayName: string | null;
      publicUserId: string | null;
      teamId: number | null;
      teamName: string | null;
      activeTeamId: number | null;
      organizationId: string | null;
      isEnterpriseUser: boolean | null;
      planName: string | null;
      planPrice: string | null;
      includedUsagePeriod: "monthly" | "weekly" | "unspecified" | null;
    };
    expectedAccount: CursorExpectedAccount | null;
    mismatch: {
      fields: Array<"email" | "userId" | "teamId">;
      message: string;
    } | null;
  };
  observedAt: string;
  observedAtMs: number;
  evaluatedAt: string;
  evaluatedAtMs: number;
  freshness: {
    state: "fresh" | "stale" | "unknown";
    isFresh: boolean;
    ageMs: number | null;
    maxAgeMs: number;
    resetPassed: boolean;
    staleReason: "max_age_exceeded" | "reset_passed" | "missing_observed_at" | null;
  };
  reset: {
    billingCycleStartAt: string | null;
    billingCycleStartAtMs: number | null;
    billingCycleEndAt: string | null;
    billingCycleEndAtMs: number | null;
    includedUsageResetsAt: string | null;
    includedUsageResetsAtMs: number | null;
    primaryResetAt: string | null;
    primaryResetAtMs: number | null;
    remainingMs: number | null;
    resetDescription: string | null;
  };
  windows: CursorUsageWindow[];
  evaluatedModel: {
    modelId: string | null;
    bucket: "included_auto" | "included_api" | "enterprise_spend" | "overall" | "unknown";
  };
  exhaustedWindows: string[];
  cautions: string[];
  error: {
    code: string;
    message: string;
    httpStatus: number | null;
    connectCode: string | null;
    rateLimited: boolean;
    retryAfterMs: number | null;
  } | null;
}

export interface ReadCursorUsageOptions {
  host?: string;
  hostMap?: Record<string, CursorHostMappingEntry>;
  endpoint?: string;
  authFilePath?: string;
  configFilePath?: string;
  expectedAccount?: CursorExpectedAccount;
  model?: string | null;
  lowCapacityRemainingPercent?: number;
  maxAgeMs?: number;
  timeoutMs?: number;
  now?: number | string | Date;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homedir?: string;
  hostname?: string;
  localHostname?: string;
  fetchImpl?: typeof fetch;
}

export interface EvaluateCursorObservationOptions {
  now?: number | string | Date;
  maxAgeMs?: number;
  model?: string | null;
  lowCapacityRemainingPercent?: number;
  expectedAccount?: CursorExpectedAccount;
}

export const DEFAULT_MAX_AGE_MS: number;
export const DEFAULT_LOW_CAPACITY_REMAINING_PERCENT: number;
export const DEFAULT_CURSOR_ENDPOINT: string;

export function resolveCursorCredentialPaths(options?: {
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: Record<string, string | undefined>;
  authFilePath?: string;
  configFilePath?: string;
}): {
  authFilePath: string;
  configFilePath: string;
};

export function redactSecrets(text: string, knownSecrets?: string[]): string;

export function readCursorUsage(
  options?: ReadCursorUsageOptions,
): Promise<CursorUsageObservation>;

export function evaluateCursorObservation(
  observation: CursorUsageObservation,
  options?: EvaluateCursorObservationOptions,
): CursorUsageObservation;

export function candidateAvailability(
  observation: CursorUsageObservation | null | undefined,
  candidate?: { model?: string | null; surface?: string | null },
  now?: number | string | Date,
): CursorCandidateAvailability;

export function formatCursorUsageText(observation: CursorUsageObservation): string;

export function parseCliArgs(argv: string[]):
  | { ok: true; options: Record<string, unknown> }
  | { ok: false; error: string };

export function main(
  argv?: string[],
  io?: {
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    env?: Record<string, string | undefined>;
  },
): Promise<number>;
