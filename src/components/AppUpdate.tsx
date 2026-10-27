import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { usePlayer } from "../player";
import { localDB } from "../lib";
declare const __SONDER_BUILD_ID__: string;
export function AppUpdate() {
  const [available, setAvailable] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const dismissed = useRef<string | null>(null);
  const player = usePlayer();
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let active = true;
    const check = async () => {
      if (!navigator.onLine || document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/build.json", {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return;
        const build = await response.json();
        if (
          active &&
          typeof build.id === "string" &&
          build.id !== __SONDER_BUILD_ID__ &&
          build.id !== dismissed.current
        )
          setAvailable(build.id);
      } catch {}
    };
    void check();
    const interval = setInterval(() => void check(), 60000);
    const visible = () => void check();
    window.addEventListener("focus", visible);
    window.addEventListener("online", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", visible);
      window.removeEventListener("online", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  if (!available) return null;
  return (
    <aside className="app-update" role="status">
      <span>
        <strong>An app update is ready</strong>
        <small>
          Reload for the latest fixes. Your listening position and downloads are
          kept.
        </small>
      </span>
      <button
        className="button subtle"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          if (player.playing) player.toggle();
          window.dispatchEvent(new Event("pagehide"));
          void localDB.progress
            .toArray()
            .then(() => location.reload())
            .catch(() => setApplying(false));
        }}
      >
        <RefreshCw size={14} />
        {applying ? "Reloading…" : "Reload app"}
      </button>
      <button
        className="icon-button"
        aria-label="Dismiss update notice"
        onClick={() => {
          dismissed.current = available;
          setAvailable(null);
        }}
      >
        <X size={15} />
      </button>
    </aside>
  );
}
