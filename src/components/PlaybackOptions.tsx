import { useState } from "react";
import { Check, Timer } from "lucide-react";
import { usePlayer } from "../player";
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
        aria-label={kind === "speed" ? `Playback speed, ${p.speed}×` : "Sleep timer"}
        aria-expanded={open}
      >
        {kind === "speed" ? (
          <>
            {p.speed}
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
          <div className="option-menu">
            <span className="menu-title">
              {kind === "speed" ? "Playback speed" : "Sleep timer"}
            </span>
            {(kind === "speed"
              ? [0.75, 1, 1.25, 1.5, 1.75, 2]
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
