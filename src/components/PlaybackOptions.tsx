import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Minus, Plus, Timer } from "lucide-react";
import { useBookSpeed, useHasOwnSpeed, usePlayer } from "../player";
import type { Book } from "../types";
import {
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  SPEED_STEP,
  formatSpeed,
  stepSpeed,
} from "../playback-speed";
/** `book` is the book this control is shown for; without it, the book in the player. */
export function PlaybackOptions({
  kind,
  book,
}: {
  kind: "speed" | "sleep";
  book?: Book | null;
}) {
  return kind === "speed" ? <SpeedOptions book={book} /> : <SleepOptions />;
}
function SpeedOptions({ book }: { book?: Book | null }) {
  const p = usePlayer();
  const speed = useBookSpeed(book);
  const own = useHasOwnSpeed(book);
  const set = (value: number) => p.setSpeed(value, book?.recordingId);
  return (
    <OptionMenu
      label={`Playback speed, ${formatSpeed(speed)}×`}
      title="Playback speed"
      className="speed-menu"
      trigger={
        <>
          {formatSpeed(speed)}
          <span>×</span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="speed-control">
            <div className="speed-stepper">
              <button
                aria-label="Slower"
                disabled={speed <= SPEED_MIN}
                onClick={() => set(stepSpeed(speed, -1))}
              >
                <Minus size={15} />
              </button>
              <output aria-live="polite">{formatSpeed(speed)}×</output>
              <button
                aria-label="Faster"
                disabled={speed >= SPEED_MAX}
                onClick={() => set(stepSpeed(speed, 1))}
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
              value={speed}
              aria-valuetext={`${formatSpeed(speed)}×`}
              onChange={(event) => set(Number(event.target.value))}
            />
          </div>
          {SPEED_PRESETS.map((value) => (
            <button
              key={value}
              onClick={() => {
                set(value);
                close();
              }}
            >
              {`${value}×${value === 1 ? " · Normal" : ""}`}
              {speed === value && <Check size={15} />}
            </button>
          ))}
          {own.recordingId && (
            <button
              className="speed-default"
              aria-pressed={own.has === false}
              onClick={() => {
                p.resetSpeed(own.recordingId!);
                close();
              }}
            >
              {`Use default · ${formatSpeed(p.defaultSpeed)}×`}
              {own.has === false && <Check size={15} />}
            </button>
          )}
        </>
      )}
    </OptionMenu>
  );
}
function SleepOptions() {
  const p = usePlayer();
  const minutes = p.sleep ? Math.ceil(p.sleep / 60) : null;
  return (
    <OptionMenu
      label="Sleep timer"
      title="Sleep timer"
      active={!!p.sleep}
      trigger={
        <>
          <Timer size={19} />
          {minutes && <span>{minutes}m</span>}
        </>
      }
    >
      {(close) =>
        [null, 5, 15, 30, 45, 60].map((value) => (
          <button
            key={String(value)}
            onClick={() => {
              p.setSleep(value);
              close();
            }}
          >
            {value === null ? "Turn off" : `${value} minutes`}
            {minutes === value && <Check size={15} />}
          </button>
        ))
      }
    </OptionMenu>
  );
}
function OptionMenu({
  label,
  title,
  trigger,
  active = false,
  className = "",
  children,
}: {
  label: string;
  title: string;
  trigger: ReactNode;
  active?: boolean;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !menu.current) return setShift(null);
    setShift(menuShift(menu.current));
  }, [open]);
  return (
    <div className="player-option">
      <button
        className={`player-text-button ${active ? "active" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={label}
        aria-expanded={open}
      >
        {trigger}
      </button>
      {open && (
        <>
          <button
            className="menu-backdrop"
            aria-label="Close options"
            onClick={() => setOpen(false)}
          />
          <div
            ref={menu}
            className={`option-menu ${className}`}
            style={shift ? { translate: `${shift.x}px ${shift.y}px` } : undefined}
          >
            <span className="menu-title">{title}</span>
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}
/**
 * How far to move an open menu so it stays inside the area that shows it: the
 * viewport, cut by any scrolling ancestor such as Now Playing. A centred menu
 * over a button near the edge of a phone screen otherwise starts off-screen.
 */
function menuShift(el: HTMLElement, margin = 8) {
  let left = 0,
    top = 0,
    right = window.innerWidth,
    bottom = window.innerHeight;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  const box = el.getBoundingClientRect();
  const fit = (start: number, end: number, from: number, to: number) =>
    start < from + margin
      ? from + margin - start
      : end > to - margin
        ? -Math.min(end - (to - margin), Math.max(0, start - (from + margin)))
        : 0;
  return {
    x: Math.round(fit(box.left, box.right, left, right)),
    y: Math.round(fit(box.top, box.bottom, top, bottom)),
  };
}
