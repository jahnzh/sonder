import { useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { usePlayer } from "../player";
import { dismissUpdate, reloadForUpdate, useUpdateNotice, useUpdateNoticeClaimed } from "../app-update";
export function AppUpdate() {
  // Dismissing hides the notice for this build only; Settings › App still says an update is ready.
  const available = useUpdateNotice();
  // A reader on screen shows the update in its foot instead (#591): nothing is drawn over the book's text. Settings ›
  // App, with its own Updates row and Reload, takes it too (#733): one Reload on screen.
  const inReader = useUpdateNoticeClaimed();
  const [applying, setApplying] = useState(false);
  const player = usePlayer();
  const shown = !!available && !inReader;
  const notice = useRef<HTMLElement>(null);
  // The notice stands in the shell's foot (shell.css, #733): its height and gaps are kept free under the page's
  // content, so it never lies over it, and the toast stands above it.
  useLayoutEffect(() => {
    const element = notice.current;
    const shell = element?.closest<HTMLElement>(".app-shell");
    if (!element || !shell) return;
    const keep = () => shell.style.setProperty("--shell-update", `calc(${element.offsetHeight}px + var(--space-16) + var(--space-8))`);
    // The observer calls it once at the start, then at every change of height (a narrower window wraps the text).
    const observer = new ResizeObserver(keep);
    observer.observe(element);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--shell-update");
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <aside ref={notice} className="app-update" role="status">
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
