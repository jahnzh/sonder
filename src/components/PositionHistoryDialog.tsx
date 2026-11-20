import { type RefObject } from "react";
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
  device: "Other device",
};

/** Position history (Earlier positions on Now playing's Listen face, #593): recent jumps; a row restores one. */
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
      {p.positionHistory.length === 0 ? (
        <p className="position-history-empty">No jumps in the last 24 hours</p>
      ) : (
        <ul className="position-history-list">
          {[...p.positionHistory].reverse().map((entry) => {
            const playing = p.book;
            const track = playing?.tracks.find((item) => item.id === entry.trackId);
            const chapter = playing && track
              ? currentChapter(playing, entry.trackId, entry.position)?.title || track.title
              : null;
            const label = `${jumpKindLabel[entry.kind]} · ${clock(entry.position)}${chapter ? ` · ${chapter.replace(/^\d+[. -]*/, "")}` : ""}`;
            return (
              <li key={`${entry.timestamp}-${entry.trackId}-${entry.position}-${entry.kind}`}>
                <button
                  type="button"
                  className="button subtle position-history-entry"
                  onClick={() => {
                    p.restoreJump(entry);
                    onOpenChange(false);
                  }}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
