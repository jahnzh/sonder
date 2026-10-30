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
  /** The Word reader is open and uses Space and the arrow keys itself. */
  wordReaderKeys?: boolean;
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
/** An open Word reader that is not hidden behind a closed Now Playing dialog and is taking keys. */
export function wordReaderOwnsKeys() {
  return Array.from(
    document.querySelectorAll('.word-reader[data-keys="true"]'),
  ).some((element) => !element.closest('[data-state="closed"]'));
}
export type WordKeyInput = PlaybackKeyInput & {
  shiftKey?: boolean;
  repeat?: boolean;
  /** A reader panel is open or the reader is hidden. */
  ignored?: boolean;
};
export type WordKeyAction =
  | { type: "toggle" }
  | { type: "step"; direction: -1 | 1 }
  | { type: "sentence"; direction: -1 | 1 }
  /** The Word reader's key, held down: handled, but it does nothing again. */
  | { type: "hold" }
  | null;
/** Space and the arrow keys in Word mode; ignores the same situations as the player. */
export function wordKeyAction(input: WordKeyInput): WordKeyAction {
  if (input.ignored || keyIgnored(input)) return null;
  const { key, shiftKey = false, repeat = false } = input;
  const direction: -1 | 1 | null =
    key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : null;
  if (key !== " " && direction === null) return null;
  if (repeat) return { type: "hold" };
  if (direction === null) return { type: "toggle" };
  return { type: shiftKey ? "sentence" : "step", direction };
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
  wordReaderKeys = false,
}: PlaybackKeyInput): PlaybackKeyAction {
  if (
    wordReaderKeys ||
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
/** One row per key; `word` is what the key does instead while the Word reader is open. */
export const KEYBOARD_SHORTCUTS: { keys: string[]; action: string; word?: string }[] = [
  {
    keys: ["Space"],
    action: "Play or pause",
    word: "Word mode without narration: start or stop the words",
  },
  {
    keys: ["←", "→"],
    action: "Skip 30 seconds back or forward",
    word: "Word mode: step one word",
  },
  { keys: ["/"], action: "Search" },
  { keys: ["f"], action: "Follow the audio in the reader" },
  { keys: ["p"], action: "Switch the reader to Page view" },
  { keys: ["Shift+←", "Shift+→"], action: "Step one sentence", word: "Word mode only" },
];
