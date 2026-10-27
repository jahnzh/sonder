import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "../lib";
import type { TorrentHealth } from "../types";

const refreshMs = 60_000;

export function useTorrentHealth() {
  const [health, setHealth] = useState<TorrentHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      const next = await api<TorrentHealth>(
        `/torrents/health${fresh ? "?fresh=1" : ""}`,
      );
      setHealth(next);
      return next;
    } catch {
      // Leave the last known state; the server itself may be unreachable.
      return null;
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void check();
    const timer = setInterval(() => {
      if (navigator.onLine) void check();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [check]);
  return { health, checking, check };
}

export function TorrentHealthLine({
  health,
  checking,
}: {
  health: TorrentHealth | null;
  checking: boolean;
}) {
  if (!health)
    return (
      <p className="queue-location" data-testid="torrent-health">
        <Loader2 className="spin" size={14} /> Checking local torrents…
      </p>
    );
  const ok = health.status === "ok";
  return (
    <p
      className={`queue-location ${ok ? "" : "error-text"}`}
      data-testid="torrent-health"
      data-status={health.status}
      role={ok ? undefined : "status"}
    >
      {checking ? (
        <Loader2 className="spin" size={14} />
      ) : ok ? (
        <CheckCircle2 size={14} />
      ) : (
        <AlertTriangle size={14} />
      )}
      {health.message}
    </p>
  );
}

export function TorrentHealthWarning() {
  const { health } = useTorrentHealth();
  if (!health || health.status === "ok" || health.status === "unconfigured")
    return null;
  return (
    <p
      className="inline-error"
      role="alert"
      data-testid="torrent-health-warning"
    >
      {health.message}
    </p>
  );
}
