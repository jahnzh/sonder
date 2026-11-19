import { useCallback, useEffect, useState } from "react";
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
