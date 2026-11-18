// The shell (spec #572, "The shell"; #581): the four places as the phone's tab bar and the desktop's rail
// (boards Library.dc.html, DesktopLibrary.dc.html, DesktopSettings.dc.html), the offline line (LibraryOffline.dc.html,
// #471) and the toast for messages outside the reader. One `nav` named "Main" is both: the tab bar under the mini
// player below 760 px, the rail with "Sonder" from 760 px (shell.css).
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Place } from "./routes";
import { connection, type ConnectionState } from "./connection";
import { OFFLINE_LINE } from "./status-lines";
import "./shell.css";

const icon = (paths: ReactNode) => (
  <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {paths}
  </svg>
);

/** The four places in their order, with the boards' icons. */
export const PLACES: readonly { id: Place; label: string; icon: ReactNode }[] = [
  { id: "library", label: "Library", icon: icon(<path d="M5 4v16M10 4v16M15 6l4 14" />) },
  { id: "discover", label: "Discover", icon: icon(<><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></>) },
  { id: "activity", label: "Activity", icon: icon(<path d="M3 12h4l3-7 4 14 3-7h4" />) },
  {
    id: "settings",
    label: "Settings",
    icon: icon(<><path d="M4 7h9M19 7h1M4 17h3M13 17h7" /><circle cx="16" cy="7" r="2.5" /><circle cx="10" cy="17" r="2.5" /></>),
  },
];

/** The attention dot's name (#516): it describes Activity, which keeps its own name. */
export const ATTENTION_NAME = "Background work needs attention";

export function PlaceNav({ current, attention, onPlace }: { current: Place; attention: boolean; onPlace: (place: Place) => void }) {
  return (
    <nav className="shell-nav" aria-label="Main">
      <div className="shell-name type-heading" aria-hidden="true">
        Sonder
      </div>
      <div className="shell-places">
        {PLACES.map((place) => (
          <button
            key={place.id}
            type="button"
            className="shell-place"
            aria-current={current === place.id ? "page" : undefined}
            aria-label={place.label}
            aria-describedby={place.id === "activity" && attention ? "activity-attention" : undefined}
            onClick={() => onPlace(place.id)}
          >
            <span className="shell-place-icon">
              {place.icon}
              {place.id === "activity" && attention && (
                <span id="activity-attention" className="shell-dot" role="img" aria-label={ATTENTION_NAME} data-testid="activity-indicator" />
              )}
            </span>
            <span className="shell-place-label">{place.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/** The connection as the shell knows it, with the browser's `online` and `offline` events fed in. */
export function useConnection(): ConnectionState {
  useEffect(() => {
    const changed = () => connection.browser(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    changed();
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, []);
  const state = useSyncExternalStore(connection.subscribe, connection.get);
  // A request that got no answer while the browser says it is online: ask the server again now and then, so the line
  // goes when the connection is back even if nothing else asks.
  useEffect(() => {
    if (state.reached || !state.browserOnline) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/health", { cache: "no-store" }).then(
        () => connection.answered(),
        () => {},
      );
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [state.reached, state.browserOnline]);
  return state;
}
const RETRY_MS = 10_000;

/** One line while there is no connection, with nothing to tap. */
export function OfflineLine() {
  return (
    <div className="offline-line type-label" role="status">
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3l18 18" />
        <path d="M7.5 8.5A5 5 0 0 0 7 18h10" />
        <path d="M11 6.1A6 6 0 0 1 19 11a4 4 0 0 1 1.5 6" />
      </svg>
      <span className="offline-line-text">
        <span className="offline-line-lead">{OFFLINE_LINE.lead}</span> · {OFFLINE_LINE.rest}
      </span>
    </div>
  );
}

/** A message outside the reader, above the mini player. */
export function Toast({ text, error, onDismiss }: { text: string; error?: boolean; onDismiss: () => void }) {
  return (
    <div className={`toast type-label${error ? " error" : ""}`} role="status">
      <span className="toast-text">{text}</span>
      <button type="button" className="toast-dismiss" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
