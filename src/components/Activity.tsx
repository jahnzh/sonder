import { useEffect, useState } from "react";
import { api } from "../lib";
import type { ActivityResponse } from "../types";

const ATTENTION_POLL_MS = 60_000;

/** How many items and processes need the administrator, for the indicator on Settings. */
export function useActivityAttention(enabled: boolean) {
  const [attention, setAttention] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setAttention(0);
      return;
    }
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      api<ActivityResponse>("/activity")
        .then((activity) => !cancelled && setAttention(activity.attention))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, ATTENTION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return attention;
}
