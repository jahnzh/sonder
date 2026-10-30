import { useRef, useState, type RefObject } from "react";
import { History } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { usePlayer } from "../player";
import { clock } from "../lib";
import { currentChapter } from "../chapters";
import type { JumpKind } from "../position-history";

const jumpKindLabel: Record<JumpKind, string> = {
  seek: "Seek",
  skip: "Skip",
  chapter: "Chapter",
  play: "Play",
  hardcover: "Hardcover",
  recording: "Recording",
  source: "Source",
};

/** Trigger for the player's Playback options panel. Always enabled. */
export function PositionHistoryButton({
  triggerRef,
  onClick,
}: {
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={triggerRef}
      type="button"
      className="button subtle"
      onClick={onClick}
    >
      <History size={16} /> Position history
    </button>
  );
}

/** Radix dialog listing recent jumps; keep nested under Now Playing so hideOthers stacks. */
export function PositionHistoryDialog({
  open,
  onOpenChange,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const p = usePlayer();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        triggerRef?.current?.focus();
      }}
      title="Position history"
      className="position-history-dialog"
    >
      <div className="position-history-list" role="list">
        {p.positionHistory.length === 0 ? (
          <p className="position-history-empty">No jumps in the last 24 hours</p>
        ) : (
          [...p.positionHistory].reverse().map((entry) => {
            const playing = p.book;
            const track = playing?.tracks.find((item) => item.id === entry.trackId);
            const chapter = playing && track
              ? currentChapter(playing, entry.trackId, entry.position)?.title || track.title
              : null;
            const label = `${jumpKindLabel[entry.kind]} · ${clock(entry.position)}${chapter ? ` · ${chapter.replace(/^\d+[. -]*/, "")}` : ""}`;
            return (
              <button
                key={`${entry.timestamp}-${entry.trackId}-${entry.position}-${entry.kind}`}
                type="button"
                className="button subtle position-history-entry"
                role="listitem"
                onClick={() => {
                  p.restoreJump(entry);
                  onOpenChange(false);
                }}
              >
                {label}
              </button>
            );
          })
        )}
      </div>
    </Dialog>
  );
}

/** Convenience wrapper when button and dialog can share a fragment (e.g. quick links). */
export function PositionHistoryControl() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <PositionHistoryButton triggerRef={trigger} onClick={() => setOpen(true)} />
      <PositionHistoryDialog open={open} onOpenChange={setOpen} triggerRef={trigger} />
    </>
  );
}
