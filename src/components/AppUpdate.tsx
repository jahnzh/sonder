import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { usePlayer } from "../player";
import { dismissUpdate, reloadForUpdate, useUpdateNotice, useUpdateNoticeClaimed } from "../app-update";
export function AppUpdate() {
  // Dismissing hides the notice for this build only; Settings › App still says an update is ready.
  const available = useUpdateNotice();
  // A reader on screen shows the update in its foot instead (#591): nothing is drawn over the book's text.
  const inReader = useUpdateNoticeClaimed();
  const [applying, setApplying] = useState(false);
  const player = usePlayer();
  if (!available || inReader) return null;
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
        onClick={() => dismissUpdate(available)}
      >
        <X size={15} />
      </button>
    </aside>
  );
}
