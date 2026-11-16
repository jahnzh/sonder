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
/** Situations in which a key belongs to something else: a field, a dialog, a shortcut. */
function keyIgnored({
  defaultPrevented = false,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
  dialogOpen = false,
  contentEditable = false,
  targetTag = null,
}: PlaybackKeyInput) {
  return (
    defaultPrevented ||
    ctrlKey ||
    metaKey ||
    altKey ||
    dialogOpen ||
    contentEditable ||
    (!!targetTag && IGNORED_TAGS.has(targetTag.toUpperCase()))
  );
}
/** What the keyboard event's target and the page say about who owns the key. */
export function keyEventContext(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const interactive = target?.closest?.(
    "input,textarea,select,button,summary,a[href]",
  );
  return {
    targetTag: interactive?.tagName ?? target?.tagName ?? null,
    contentEditable:
      !!target?.isContentEditable ||
      target?.getAttribute?.("contenteditable") === "true",
    dialogOpen: !!document.querySelector(BLOCKING_DIALOG_SELECTOR),
  };
}
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
    keyIgnored({
      key,
      defaultPrevented,
      ctrlKey,
      metaKey,
      altKey,
      dialogOpen,
      contentEditable,
      targetTag,
    })
  )
    return null;
  if (key === " ") return canPlay ? { type: "toggle" } : null;
  if (key === "ArrowLeft")
    return canSeek ? { type: "skip", seconds: -30 } : null;
  if (key === "ArrowRight")
    return canSeek ? { type: "skip", seconds: 30 } : null;
  return null;
}
/** One row per key. */
export const KEYBOARD_SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["Space"], action: "Play or pause" },
  { keys: ["←", "→"], action: "Skip 30 seconds back or forward" },
  { keys: ["/"], action: "Search" },
  { keys: ["f"], action: "Follow the audio in the reader" },
];
