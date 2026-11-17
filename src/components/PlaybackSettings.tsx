import { useState } from "react";
import { Headphones, Check } from "lucide-react";
import { useAppearance } from "./Appearance";
import { usePlayer } from "../player";
import {
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  clampSpeed,
  formatSpeed,
  resolveSpeed,
} from "../playback-speed";
export function PlaybackSettings({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const { appearance, update, savePlayback } = useAppearance(),
    [busy, setBusy] = useState(false);
  const { deviceSpeed } = usePlayer();
  const defaultSpeed = resolveSpeed({
    preferred: appearance.playback.speed,
    legacy: deviceSpeed,
  });
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
          <p>Choose the default speed and what the progress bar shows.</p>
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
      <label>
        <span className="setting-range-label">
          Default speed <output>{formatSpeed(defaultSpeed)}×</output>
        </span>
        <input
          type="range"
          aria-label="Default playback speed"
          aria-valuetext={`${formatSpeed(defaultSpeed)}×`}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={defaultSpeed}
          onChange={(event) =>
            update({
              ...appearance,
              playback: {
                ...appearance.playback,
                speed: clampSpeed(Number(event.target.value)) ?? 1,
              },
            })
          }
        />
      </label>
      <p className="muted">
        Used for books without their own speed once saved. A speed chosen in the
        player is kept for that recording on this device.
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
