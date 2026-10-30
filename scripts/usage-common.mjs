import { createHash } from "node:crypto";

export const STALE_AFTER_MS = 30 * 60 * 1000;

export class UsageError extends Error {
  constructor(status, reason, detail) {
    super(detail ?? reason);
    this.status = status;
    this.reason = reason;
    this.detail = detail ?? null;
  }
}

export function accountFingerprint(account) {
  const value = String(account).trim();
  if (/^sha256:[0-9a-f]{16}$/.test(value)) return value;
  return `sha256:${createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** Replaces links, addresses and anything shaped like a credential, keeping the rest of the text. */
export function scrub(text, secrets = []) {
  let out = String(text)
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  const literals = [...new Set(
    secrets
      .filter((secret) => typeof secret === "string" && secret.trim().length >= 6)
      .map((secret) => secret.trim()),
  )].sort((a, b) => b.length - a.length);
  for (const secret of literals) {
    out = out.replaceAll(secret, "<redacted>");
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic <redacted>")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "<redacted>")
    .replace(/\b1\/\/[A-Za-z0-9._-]+/g, "<redacted>")
    .replace(/\bAIza[0-9A-Za-z_-]{16,}/g, "<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/\b(access_token|refresh_token|id_token|api_key|apikey|client_secret|x-goog-api-key|authorization|token|secret|password)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|<redacted>)([^\s"',;})\]]+)/gi, "$1$2<redacted>");
}

export function redact(text, secrets = []) {
  return scrub(text, secrets).trim().slice(0, 300);
}

export function sameHost(requested, local) {
  if (typeof requested !== "string" || typeof local !== "string") return false;
  const target = requested.trim().toLowerCase();
  const current = local.trim().toLowerCase();
  return target !== "" && current !== "" && target === current;
}

export function assessFreshness(observation, now = new Date()) {
  const observedAt = Date.parse(observation?.observedAt);
  if (Number.isNaN(observedAt)) return { state: "stale", reasons: ["no_observation_time"], staleAfter: null };
  if (
    (observation?.status !== undefined && !["available", "limited", "exhausted", "stale"].includes(observation.status)) ||
    !Array.isArray(observation?.windows) ||
    observation.windows.length === 0
  ) {
    return {
      state: "unknown",
      reasons: [typeof observation?.reason === "string" ? observation.reason : "no_usage_windows"],
      staleAfter: null,
    };
  }
  const reasons = [];
  if (now.getTime() - observedAt > STALE_AFTER_MS) reasons.push("older_than_30_minutes");
  for (const window of observation.windows) {
    const resetsAt = Date.parse(window.resetsAt);
    if (!Number.isNaN(resetsAt) && resetsAt <= now.getTime()) reasons.push(`reset_passed:${window.id}`);
  }
  const resets = observation.windows.map((window) => Date.parse(window.resetsAt)).filter((time) => !Number.isNaN(time));
  const staleAfter = Math.min(observedAt + STALE_AFTER_MS, ...resets);
  return { state: reasons.length ? "stale" : "fresh", reasons, staleAfter: new Date(staleAfter).toISOString() };
}
