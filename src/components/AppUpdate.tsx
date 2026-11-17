import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { usePlayer } from "../player";
import { reloadForUpdate, useAvailableUpdate } from "../app-update";
export function AppUpdate() {
  const available = useAvailableUpdate();
  const [applying, setApplying] = useState(false);
  // Dismissing hides the notice for this build only; Settings › App still says an update is ready.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const player = usePlayer();
  if (!available || available === dismissed) return null;
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
          void reloadForUpdate(() => {
            if (player.playing) player.toggle();
          }).catch(() => setApplying(false));
        }}
      >
        <RefreshCw size={14} />
        {applying ? "Reloading…" : "Reload app"}
      </button>
      <button
        className="icon-button"
        aria-label="Dismiss update notice"
        onClick={() => setDismissed(available)}
      >
        <X size={15} />
      </button>
    </aside>
  );
}
