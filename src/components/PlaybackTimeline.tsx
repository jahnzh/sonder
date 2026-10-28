import {
  useId,
  useRef,
  useState,
  type PointerEvent,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import { usePlayer } from "../player";
import { useAppearance } from "./Appearance";
import { playbackTimeline } from "../chapters";
import { clock } from "../lib";
import { scrubPosition, seekSensitivity, seekSecond } from "../scrubbing";
import type { Book } from "../types";
type Timeline = NonNullable<ReturnType<typeof playbackTimeline>>;
type Drag = {
  pointer: number;
  x: number;
  center: number;
  width: number;
  value: number;
  shown: number;
  timeline: Timeline;
  commit: (value: number) => void;
};
export function PlaybackTimeline({
  book,
  compact = false,
  scoped = false,
}: {
  book: Book;
  compact?: boolean;
  // Compact layout that still names its scope, as in the desktop reader footer.
  scoped?: boolean;
}) {
  const p = usePlayer(),
    { appearance } = useAppearance();
  const actual = p.track
    ? playbackTimeline(
        p.book || book,
        p.track.id,
        p.position,
        p.length,
        appearance.playback.progressScope,
      )
    : null;
  const drag = useRef<Drag | null>(null),
    input = useRef<HTMLInputElement>(null),
    help = useId();
  const [preview, setPreview] = useState<{
    value: number;
    timeline: Timeline;
    sensitivity: number;
  } | null>(null);
  const timeline = preview?.timeline || actual;
  const length = timeline?.duration || 0,
    position = seekSecond(preview?.value ?? timeline?.position ?? 0, length);
  const disabled = !actual || !length;
  const commit = (value: number, range = actual) => {
    if (!range) return;
    if (range.scope === "book") p.seekBook(value);
    else p.seekTrack(range.trackId, range.start + value);
  };
  const show = (value: number, timeline: Timeline, sensitivity: number) => {
    // Keep the native one-second thumb, timestamp and committed destination identical.
    const shown = seekSecond(value, timeline.duration);
    flushSync(() => setPreview({ value: shown, timeline, sensitivity }));
    return shown;
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const distance = Math.max(0, Math.abs(event.clientY - current.center) - 12);
    current.value = scrubPosition(
      current.value,
      event.clientX - current.x,
      distance,
      current.timeline.duration,
      current.width,
    );
    current.x = event.clientX;
    current.shown = show(
      current.value,
      current.timeline,
      seekSensitivity(distance),
    );
  };
  const cancel = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    setPreview(null);
  };
  return (
    <div
      className={`playback-timeline ${compact ? "compact-timeline" : "expanded-timeline"}`}
      data-scope={timeline?.scope || appearance.playback.progressScope}
    >
      {!compact && (
        <div className="timeline-scope">
          <span>
            {timeline?.scope === "book"
              ? "Whole audiobook"
              : timeline?.scope === "track"
                ? "Current file · other durations unknown"
                : "Current chapter"}
          </span>
          <span>
            {preview
              ? `Fine seeking · ${Math.round(preview.sensitivity * 100)}% sensitivity`
              : "Drag away from the bar for finer seeking"}
          </span>
        </div>
      )}
      <div className={compact ? "dock-progress" : "full-progress"}>
        {compact && <span>{clock(position)}</span>}
        <div
          className="timeline-pointer-surface"
          onPointerDown={(event) => {
            if (
              disabled || !actual || !input.current ||
              event.button !== 0 || drag.current
            ) return;
            event.preventDefault();
            input.current.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            const rect = input.current.getBoundingClientRect(),
              width = Math.max(1, rect.width - 18);
            const target = Math.max(
              0,
              Math.min(
                length,
                ((event.clientX - rect.left - 9) / width) * length,
              ),
            );
            const thumb = rect.left + 9 + (position / length) * width;
            const value =
              Math.abs(event.clientX - thumb) <= 18 ? position : target;
            drag.current = {
              pointer: event.pointerId,
              x: event.clientX,
              center: rect.top + rect.height / 2,
              width,
              value,
              shown: show(value, actual, 1),
              timeline: actual,
              commit: (value) => commit(value, actual),
            };
          }}
          onPointerMove={move}
          onPointerUp={(event) => {
            const current = drag.current;
            if (!current || current.pointer !== event.pointerId) return;
            drag.current = null;
            setPreview(null);
            // Pointer-up coordinates can differ from the last painted movement.
            // Release commits the preview, never a new, unseen destination.
            current.commit(current.shown);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
        >
          <input
            ref={input}
            type="range"
            className={compact ? "dock-seek" : "full-seek"}
            min="0"
            max={length || 1}
            step="1"
            value={position}
            disabled={disabled}
            aria-label={
              compact && !scoped
                ? "Playback position"
                : timeline?.scope === "chapter"
                  ? "Seek in chapter"
                  : timeline?.scope === "track"
                    ? "Seek in audio file"
                    : "Seek in audiobook"
            }
            aria-valuetext={`${clock(position)} elapsed, ${clock(Math.max(0, length - position))} remaining${timeline?.scope === "chapter" ? ` in ${timeline.title}` : ""}`}
            aria-describedby={help}
            style={
              { "--range-progress": `${length ? (position / length) * 100 : 0}%` } as CSSProperties
            }
            onChange={(event) => {
              if (!drag.current) commit(Number(event.target.value));
            }}
          />
        </div>
        {compact && <span>{clock(length)}</span>}
      </div>
      {!compact && (
        <div className="full-timestamps">
          <span>{clock(position)}</span>
          <span>−{clock(Math.max(0, length - position))}</span>
        </div>
      )}
      <span id={help} className="sr-only">
        Drag horizontally to seek. Move your finger or pointer farther above or
        below the bar to seek more slowly. Use arrow keys for one-second
        changes.
      </span>
    </div>
  );
}
