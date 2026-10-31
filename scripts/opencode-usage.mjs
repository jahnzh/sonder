#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredModel, OPENCODE_MODEL, readOpencodeConfig } from "./opencode-config.mjs";
import { assessmentVerdict, STALE_AFTER_MS } from "./usage-common.mjs";

export const DEFAULT_EXPIRY = "2026-11-07T00:00:00Z";
const BUCKET = { id: "opencode-nris", label: "NRIS gateway (no quota)", usedPercent: null, resetsAt: null };
const SOURCE = { kind: "opencode-gateway-probe", official: false };

/** Probe the configured endpoint without retaining its URL, credentials, or response body. */
export async function readOpencodeUsage({
  configPath,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  expiresAt = process.env.ORCA_OPENCODE_EXPIRES_AT ?? DEFAULT_EXPIRY,
  env = process.env,
  timeoutMs = 10_000,
  signal,
} = {}) {
  const observedAt = now();
  const observation = {
    provider: "opencode", source: SOURCE, scope: { host: null }, observedAt: observedAt.toISOString(),
    status: "unavailable", reason: null, windows: [], unlimited: false, capacityConfirmed: false,
    bucket: { id: BUCKET.id, label: BUCKET.label }, expiresAt: null,
  };
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return { ...observation, reason: "invalid access expiry" };
  observation.expiresAt = new Date(expiry).toISOString();
  if (expiry <= observedAt.getTime()) return { ...observation, reason: "access expired" };

  let config;
  try {
    config = readOpencodeConfig(configPath);
  } catch {
    return { ...observation, reason: "config missing or invalid" };
  }
  if (!configuredModel(config)) return { ...observation, reason: "configured default model unavailable" };
  const options = config.provider.nris.options;
  let url;
  try {
    url = new URL(options?.baseURL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid endpoint");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  } catch {
    return { ...observation, reason: "gateway endpoint missing or invalid" };
  }

  // OpenCode permits an env reference for an API key; never log or store either form.
  let key = options?.apiKey;
  const envReference = typeof key === "string" ? /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(key) : null;
  if (envReference) key = env[envReference[1]];
  const headers = typeof key === "string" && key ? { Authorization: `Bearer ${key}` } : {};
  try {
    const deadline = AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000);
    const response = await fetchImpl(url.href, { headers, redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    // This is a reachability probe; release the response without retaining its contents.
    try { await response.body?.cancel(); } catch { /* a closed response needs no cleanup */ }
    if (!response.ok) return { ...observation, reason: `gateway unavailable (HTTP ${Number(response.status) || 0})` };
  } catch {
    return { ...observation, reason: "gateway unreachable" };
  }
  return { ...observation, status: "available", reason: null, unlimited: true, capacityConfirmed: true };
}

export function assessOpencodeUsage(observation, now = new Date()) {
  const expiry = Date.parse(observation?.expiresAt);
  const observed = Date.parse(observation?.observedAt);
  const staleAfter = Number.isFinite(expiry) && Number.isFinite(observed)
    ? new Date(Math.min(expiry, observed + STALE_AFTER_MS)).toISOString() : null;
  const verdict = (status, reason, freshness = status) => assessmentVerdict({ state: freshness, staleAfter }, status, reason);
  if (Number.isFinite(expiry) && now.getTime() >= expiry) return verdict("unavailable", "access expired");
  if (observation?.status === "unavailable") return verdict("unavailable", observation.reason ?? "gateway unavailable");
  if (!Number.isFinite(expiry) || !Number.isFinite(observed) || observation?.status !== "available" || observation?.unlimited !== true) {
    return verdict("unknown", "no valid gateway reading");
  }
  if (now.getTime() - observed > STALE_AFTER_MS) return verdict("stale", "gateway reading older than 30 minutes");
  return verdict("fresh", "NRIS gateway (no quota)");
}

export function assessCandidateUsage(observation, candidate = {}, now = new Date()) {
  if (candidate.model !== OPENCODE_MODEL) {
    return { ...assessmentVerdict({ state: "unknown" }, "unknown", "unrecognised model"), buckets: [] };
  }
  return { ...assessOpencodeUsage(observation, now), buckets: [BUCKET] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    console.log("Usage: node scripts/opencode-usage.mjs\nReports gateway reachability and temporary unlimited access as JSON.");
  } else if (process.argv.length !== 2) {
    console.error("Usage: node scripts/opencode-usage.mjs");
    process.exitCode = 2;
  } else {
    const observation = await readOpencodeUsage();
    console.log(JSON.stringify({ ...observation, assessment: assessOpencodeUsage(observation) }, null, 2));
  }
}
