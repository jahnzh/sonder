import { useState } from "react";
import { Check, Minus, Plus, Timer } from "lucide-react";
import { usePlayer } from "../player";
import {
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  SPEED_STEP,
  formatSpeed,
  stepSpeed,
} from "../playback-speed";
export function PlaybackOptions({ kind }: { kind: "speed" | "sleep" }) {
  const p = usePlayer();
  const [open, setOpen] = useState(false);
  const selected =
    kind === "speed" ? p.speed : p.sleep ? Math.ceil(p.sleep / 60) : null;
  return (
    <div className="player-option">
      <button
        className={`player-text-button ${kind === "sleep" && p.sleep ? "active" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={kind === "speed" ? `Playback speed, ${formatSpeed(p.speed)}×` : "Sleep timer"}
        aria-expanded={open}
      >
        {kind === "speed" ? (
          <>
            {formatSpeed(p.speed)}
            <span>×</span>
          </>
        ) : (
          <>
            <Timer size={19} />
            {p.sleep && <span>{Math.ceil(p.sleep / 60)}m</span>}
          </>
        )}
      </button>
      {open && (
        <>
          <button
            className="menu-backdrop"
            aria-label="Close options"
            onClick={() => setOpen(false)}
          />
          <div className={`option-menu ${kind === "speed" ? "speed-menu" : ""}`}>
            <span className="menu-title">
              {kind === "speed" ? "Playback speed" : "Sleep timer"}
            </span>
            {kind === "speed" && (
              <div className="speed-control">
                <div className="speed-stepper">
                  <button
                    aria-label="Slower"
                    disabled={p.speed <= SPEED_MIN}
                    onClick={() => p.setSpeed(stepSpeed(p.speed, -1))}
                  >
                    <Minus size={15} />
                  </button>
                  <output aria-live="polite">{formatSpeed(p.speed)}×</output>
                  <button
                    aria-label="Faster"
                    disabled={p.speed >= SPEED_MAX}
                    onClick={() => p.setSpeed(stepSpeed(p.speed, 1))}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <input
                  type="range"
                  aria-label="Playback speed"
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={SPEED_STEP}
                  value={p.speed}
                  aria-valuetext={`${formatSpeed(p.speed)}×`}
                  onChange={(event) => p.setSpeed(Number(event.target.value))}
                />
              </div>
            )}
            {(kind === "speed"
              ? SPEED_PRESETS
              : [null, 5, 15, 30, 45, 60]
            ).map((value) => (
              <button
                key={String(value)}
                onClick={() => {
                  if (kind === "speed") p.setSpeed(value!);
                  else p.setSleep(value);
                  setOpen(false);
                }}
              >
                {value === null
                  ? "Turn off"
                  : kind === "speed"
                    ? `${value}×${value === 1 ? " · Normal" : ""}`
                    : `${value} minutes`}
                {selected === value && <Check size={15} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
