import { useCallback, useEffect, useRef, useState } from "react";
import { api, localDB, userId } from "../lib";
import { accountAnswer } from "../account-answer";
import type { HardcoverState } from "../types";
export function hardcoverChanged() {
  window.dispatchEvent(new Event("sonder:hardcover-changed"));
}
/**
 * The state last read, for the account it was read for. A page shown again (Back to the Library) starts from it
 * instead of from "not connected", so it has its height at once and a restored scroll position stays on the
 * book it was on; the fresh state replaces it when it arrives.
 */
const lastState = accountAnswer<HardcoverState>(userId);
/** The user's Hardcover state (`GET /api/hardcover`), kept current: the Library's picker (#578), Settings and the Hardcover page (#529). */
export function useHardcover() {
  const lastSeenSync = useRef(0);
  const [state, setState] = useState<HardcoverState | null>(() => lastState.kept() ?? null);
  const refresh = useCallback(async () => {
    try {
      const answer = await lastState.read(() => api<HardcoverState>("/hardcover"));
      // Asked as an account that is no longer signed in: not this account's state, nor its device's copy.
      if (!answer) return;
      const next = answer.value;
      setState(next);
      if (next.lastSync !== lastSeenSync.current) {
        lastSeenSync.current = next.lastSync;
        window.dispatchEvent(new Event("sonder:library-changed"));
      }
      await localDB.preferences.put({ key: "hardcover", value: next });
    } catch {
      const cached = await localDB.preferences.get("hardcover");
      if (cached?.value) setState(cached.value as HardcoverState);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible")
        void refresh();
    }, 60000);
    const changed = () => void refresh();
    window.addEventListener("sonder:hardcover-changed", changed);
    window.addEventListener("online", changed);
    return () => {
      clearInterval(timer);
      window.removeEventListener("sonder:hardcover-changed", changed);
      window.removeEventListener("online", changed);
    };
  }, [refresh]);
  return { state, refresh };
}
