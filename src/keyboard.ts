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
  '[role="dialog"][data-state="open"]:not(.now-playing-screen)';
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
const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** The key goes to a field the reader is typing in: it must reach the field, not a shortcut. */
export function typingInField({ targetTag = null, contentEditable = false }: Pick<PlaybackKeyInput, "targetTag" | "contentEditable">) {
  return contentEditable || (!!targetTag && TEXT_ENTRY_TAGS.has(targetTag.toUpperCase()));
}
export type ReaderKeyInput = PlaybackKeyInput & {
  /** Appearance is docked under the text. */
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
  const { key, panelOpen = false, readerHidden = false, narration = false, playerHasBook = false } = input;
  if (
    input.defaultPrevented || input.ctrlKey || input.metaKey || input.altKey ||
    input.dialogOpen || panelOpen || readerHidden || typingInField(input)
  )
    return null;
  if (key.toLowerCase() === "f") return narration ? { type: "back-to-narration" } : null;
  if ((key === "ArrowLeft" || key === "ArrowRight") && !playerHasBook && !keyIgnored(input))
    return { type: "page", direction: key === "ArrowLeft" ? "previous" : "next" };
  return null;
}
export type SearchKeyInput = PlaybackKeyInput & {
  /** A search field of the page shown carries the search key's data attribute (the Library's, Discover's). */
  hasField?: boolean;
};
export type SearchKeyAction = { type: "search" } | null;
/** The data attribute that marks the search field `/` puts the focus in. */
export const SEARCH_KEY_ATTRIBUTE = "data-search-key";
/** The event the field is sent before it is focused: the Library opens its search in place of the Title row. */
export const SEARCH_KEY_EVENT = "sonder:search-key";
/**
 * `/` focuses the search of the page shown (the Library's, Discover's): not while typing in a field (the `/` is
 * typed), not with Ctrl, Alt or Meta, not with a dialog or sheet open, and not on a page without such a field.
 * Shift is allowed: on a Nordic keyboard `/` is Shift+7.
 */
export function searchKeyAction(input: SearchKeyInput): SearchKeyAction {
  if (input.key !== "/") return null;
  if (input.defaultPrevented || input.ctrlKey || input.metaKey || input.altKey || input.dialogOpen) return null;
  if (typingInField(input)) return null;
  return input.hasField ? { type: "search" } : null;
}
/** Any dialog or sheet that is open: Now playing, the reader and the Get sheets cover the page whose search it is. */
const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"], [role="dialog"]:not([data-state])';
/** The page's search field that `/` focuses, found by its data attribute. */
export function searchKeyField(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${SEARCH_KEY_ATTRIBUTE}]`);
}
/** The `/` key, wired to the document: the page's search field opens and takes the focus. */
export function handleSearchKey(event: KeyboardEvent) {
  const field = searchKeyField();
  const { targetTag, contentEditable } = keyEventContext(event);
  const action = searchKeyAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    defaultPrevented: event.defaultPrevented,
    targetTag,
    contentEditable,
    dialogOpen: !!document.querySelector(OPEN_DIALOG_SELECTOR),
    hasField: !!field,
  });
  if (!action || !field) return;
  event.preventDefault();
  field.dispatchEvent(new CustomEvent(SEARCH_KEY_EVENT));
  field.focus();
}

export type ShortcutGroup = "Listening" | "Reading" | "Library and Discover";
export type KeyboardShortcut = {
  group: ShortcutGroup;
  action: string;
  /** The key as the page shows it. */
  key: string;
  /** When the key does this, under the action ("While nothing plays"). */
  note?: string;
};
/**
 * The keys that work, one row each, in the order of Settings › Playback › Keyboard shortcuts (SettingsKeys.dc.html).
 * tests/keyboard.test.ts keeps this list equal to the keys the functions above handle.
 */
export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { group: "Listening", action: "Play or pause", key: "Space" },
  { group: "Listening", action: "Back 30 seconds", key: "←" },
  { group: "Listening", action: "Forward 30 seconds", key: "→" },
  { group: "Reading", action: "Back to narration", key: "F" },
  { group: "Reading", action: "Previous page", key: "←", note: "While nothing plays" },
  { group: "Reading", action: "Next page", key: "→", note: "While nothing plays" },
  { group: "Library and Discover", action: "Search", key: "/" },
];
/** The `KeyboardEvent.key` of a key as the list shows it. */
export function eventKey(shown: string): string {
  return { Space: " ", "←": "ArrowLeft", "→": "ArrowRight" }[shown] ?? shown;
}
/** The list in its groups, in order. */
export function shortcutGroups(list: readonly KeyboardShortcut[] = KEYBOARD_SHORTCUTS) {
  const groups: { group: ShortcutGroup; rows: KeyboardShortcut[] }[] = [];
  for (const row of list) {
    const last = groups[groups.length - 1];
    if (last?.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return groups;
}
