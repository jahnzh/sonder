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
  '[role="dialog"][data-state="open"]:not(.now-playing-screen):not(.reader-dialog)';
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
/** An open panel that is not a dialog: the More panel of the reader on Now playing's Read face (#593), which took the
 * place of Playback options above the reader. */
export const OPEN_SHEET_SELECTOR = '.inline-reader .reader-panel';
const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** The key goes to a field the reader is typing in: it must reach the field, not a shortcut. */
export function typingInField({ targetTag = null, contentEditable = false }: Pick<PlaybackKeyInput, "targetTag" | "contentEditable">) {
  return contentEditable || (!!targetTag && TEXT_ENTRY_TAGS.has(targetTag.toUpperCase()));
}
export type ReaderKeyInput = PlaybackKeyInput & {
  /** A sheet above the reader is open (see OPEN_SHEET_SELECTOR). */
  sheetOpen?: boolean;
  /** One of the reader's own panels (contents, search, appearance, More…) is open. */
  panelOpen?: boolean;
  /** The reader is mounted but not shown: Now Playing's dialog is closed. */
  readerHidden?: boolean;
  /** The player holds the narration of the open book. */
  narration?: boolean;
  /** The player holds a book, so the arrow keys seek it instead of turning pages. */
  playerHasBook?: boolean;
};
export type ReaderKeyAction =
  | { type: "back-to-narration" }
  | { type: "page"; direction: "previous" | "next" }
  | null;
/**
 * The reader's own keys: `F` (back to narration) and, with no book in the player, the arrows (page turns).
 * The reader has the keyboard only while nothing is above it and nobody is typing. A focused button
 * does not take `F`, so `F` still works right after a page button or the player's controls were used.
 */
export function readerKeyAction(input: ReaderKeyInput): ReaderKeyAction {
  const { key, sheetOpen = false, panelOpen = false, readerHidden = false, narration = false, playerHasBook = false } = input;
  if (
    input.defaultPrevented || input.ctrlKey || input.metaKey || input.altKey ||
    input.dialogOpen || sheetOpen || panelOpen || readerHidden || typingInField(input)
  )
    return null;
  if (key.toLowerCase() === "f") return narration ? { type: "back-to-narration" } : null;
  if ((key === "ArrowLeft" || key === "ArrowRight") && !playerHasBook && !keyIgnored(input))
    return { type: "page", direction: key === "ArrowLeft" ? "previous" : "next" };
  return null;
}
/** One row per key. */
export const KEYBOARD_SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["Space"], action: "Play or pause" },
  { keys: ["←", "→"], action: "Skip 30 seconds back or forward" },
  { keys: ["/"], action: "Search" },
  { keys: ["f"], action: "Follow the audio in the reader" },
];
