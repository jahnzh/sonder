import {
  transmission,
  transmissionConfigured,
  TransmissionError,
} from "./transmission.ts";
import type { TorrentHealth } from "../src/types.ts";

// Healthy results are kept longer so open Settings/Downloads pages don't hammer the port checker.
const healthyTtlMs = 5 * 60_000;
const failingTtlMs = 30_000;
// Transmission itself waits ~15 s for the port checker when its DNS is broken.
const portTestTimeoutMs = 25_000;
let cached: { key: string; health: TorrentHealth } | null = null;
let pending: { key: string; promise: Promise<TorrentHealth> } | null = null;

function cacheKey() {
  return `${process.env.TRANSMISSION_RPC_URL || ""}\n${process.env.TRANSMISSION_USERNAME || ""}`;
}

export async function probeTorrentHealth(): Promise<TorrentHealth> {
  const checkedAt = Date.now();
  if (!transmissionConfigured())
    return {
      status: "unconfigured",
      session: false,
      network: "unknown",
      version: null,
      message:
        "Local torrents are not configured. Run the local torrent setup script on your server.",
      checkedAt,
    };
  let version: string | null = null;
  try {
    const session = await transmission<{ version?: string }>("session-get", {
      fields: ["version"],
    });
    version = session.version || null;
  } catch (error) {
    const failure =
      error instanceof TransmissionError ? error.failure : undefined;
    return {
      status:
        failure === "unreachable" ? "unreachable" : failure === "auth" ? "auth" : "error",
      session: false,
      network: "unknown",
      version: null,
      message: (error as Error).message,
      checkedAt,
    };
  }
  try {
    const test = await transmission<{ "port-is-open"?: boolean }>(
      "port-test",
      {},
      portTestTimeoutMs,
    );
    const open = test["port-is-open"] === true;
    return {
      status: "ok",
      session: true,
      network: open ? "ok" : "port-closed",
      version,
      message: open
        ? "Local torrents are ready."
        : "Local torrents are ready. The incoming peer port is closed, so downloads may be slower.",
      checkedAt: Date.now(),
    };
  } catch (error) {
    const failure =
      error instanceof TransmissionError ? error.failure : undefined;
    // The RPC answered moments ago, so a port-test failure means the client has no working route or DNS through the VPN.
    return {
      status: failure === "auth" ? "auth" : "offline",
      session: failure !== "auth",
      network: "failed",
      version,
      message:
        failure === "auth"
          ? (error as Error).message
          : "The local torrent client has no internet connection through the VPN. Downloads will not start until the VPN container is fixed.",
      checkedAt: Date.now(),
    };
  }
}

export async function getTorrentHealth(
  maxAgeMs?: number,
): Promise<TorrentHealth> {
  const key = cacheKey();
  if (cached?.key === key) {
    const ttl =
      maxAgeMs ??
      (cached.health.status === "ok" ? healthyTtlMs : failingTtlMs);
    if (Date.now() - cached.health.checkedAt < ttl) return cached.health;
  }
  if (pending?.key === key) return pending.promise;
  const promise = probeTorrentHealth()
    .then((health) => {
      if (cacheKey() === key) cached = { key, health };
      return health;
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });
  pending = { key, promise };
  return promise;
}

export function resetTorrentHealth() {
  cached = null;
  pending = null;
}
