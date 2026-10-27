import { useState } from "react";
import { Headphones, Check } from "lucide-react";
import { useAppearance } from "./Appearance";
export function PlaybackSettings({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const { appearance, update, savePlayback } = useAppearance(),
    [busy, setBusy] = useState(false);
  return (
    <section
      className="settings-section playback-settings"
      aria-label="Playback settings"
    >
      <div className="settings-section-heading">
        <span className="settings-section-icon">
          <Headphones size={20} />
        </span>
        <div>
          <h2>Playback</h2>
          <p>Choose what the playback progress bar shows.</p>
        </div>
      </div>
      <label>
        Progress bar
        <select
          aria-label="Playback progress bar"
          value={appearance.playback.progressScope}
          onChange={(event) =>
            update({
              ...appearance,
              playback: {
                ...appearance.playback,
                progressScope: event.target.value as "book" | "chapter",
              },
            })
          }
        >
          <option value="book">Whole audiobook</option>
          <option value="chapter">Current chapter</option>
        </select>
      </label>
      <p className="muted">
        Chapter mode shows elapsed and remaining time within the current
        chapter, including chapters inside a single M4B file.
      </p>
      <p className="muted">
        For precise seeking, hold the progress bar and drag farther above or
        below it to slow down. Release to seek.
      </p>
      <button
        className="button primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void savePlayback()
            .then(() => notify("Playback settings saved."))
            .catch((error) => notify(error.message, true))
            .finally(() => setBusy(false));
        }}
      >
        <Check size={16} /> Save playback settings
      </button>
    </section>
  );
}
