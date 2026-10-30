export type PlaybackKeyInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  targetTag?: string | null;
  contentEditable?: boolean;
  dialogOpen?: boolean;
  canPlay?: boolean;
  canSeek?: boolean;
};
export type PlaybackKeyAction =
  | { type: "toggle" }
  | { type: "skip"; seconds: -30 | 30 }
  | null;
const IGNORED_TAGS = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "BUTTON",
  "SUMMARY",
  "A",
]);
export const BLOCKING_DIALOG_SELECTOR =
  '[role="dialog"][data-state="open"]:not(.now-playing-dialog):not(.book-detail-dialog):not(.reader-dialog)';
export function playbackKeyAction({
  key,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
  defaultPrevented = false,
  targetTag = null,
  contentEditable = false,
  dialogOpen = false,
  canPlay = true,
  canSeek = canPlay,
}: PlaybackKeyInput): PlaybackKeyAction {
  if (
    defaultPrevented ||
    ctrlKey ||
    metaKey ||
    altKey ||
    dialogOpen ||
    contentEditable
  )
    return null;
  if (targetTag && IGNORED_TAGS.has(targetTag.toUpperCase())) return null;
  if (key === " ") return canPlay ? { type: "toggle" } : null;
  if (key === "ArrowLeft")
    return canSeek ? { type: "skip", seconds: -30 } : null;
  if (key === "ArrowRight")
    return canSeek ? { type: "skip", seconds: 30 } : null;
  return null;
}
export const KEYBOARD_SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["Space"], action: "Play or pause" },
  { keys: ["←", "→"], action: "Skip 30 seconds back or forward" },
  { keys: ["/"], action: "Search" },
  { keys: ["f"], action: "Follow the audio in the reader" },
  { keys: ["p"], action: "Switch the reader to Page view" },
  { keys: ["←", "→"], action: "In Word mode, step one word" },
  { keys: ["Shift+←", "Shift+→"], action: "In Word mode, step one sentence" },
];
