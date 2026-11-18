// The reader's messages in the foot (#591, ADR 0019, spec #586 "Messages in the foot"): one message at a time, in
// the foot's lower row, with Play or Pause kept at its end. This module decides which one shows and when a notice
// leaves; the reader holds the state and acts on the answers. The clock is passed in, so the rule is tested
// without waiting.

/** How long a notice with Undo stays when nothing else is tapped. */
export const NOTICE_MS = 8000;

/** The reader's errors, each with its own sentence (the server's own sentence is never shown). */
export type ReaderError =
  | "narration"
  | "locate"
  | "bookmark-save"
  | "bookmark-remove"
  | "no-sync"
  | "no-map"
  | "no-recording";

/** The notices with Undo. */
export type ReaderNotice = "listening" | "bookmark-removed";

/** What the reader posted and has not yet seen answered. A newer message of a kind replaces the older one. */
export type ReaderMessages = {
  error: { error: ReaderError; at: number } | null;
  notice: { notice: ReaderNotice; at: number } | null;
};

/** Where the reader is, beside what it posted: the conflict and the update come from outside the reader. */
export type MessageContext = {
  now: number;
  /** Whether the narration plays: an update waits until it is paused. */
  playing: boolean;
  /** A place saved elsewhere, by the chapter it is in (empty when the section is not known). */
  conflict: { chapter: string } | null;
  /** The newer build on the server, unless it was dismissed. */
  update: string | null;
  /** Back to narration is locating the passage from the audio (#592); absent in callers from before it. */
  locating?: boolean;
};

export type ReaderMessage =
  | { kind: "conflict"; chapter: string }
  | { kind: "error"; error: ReaderError }
  | { kind: "notice"; notice: ReaderNotice }
  | { kind: "locating" }
  | { kind: "update"; build: string };

export const noMessages: ReaderMessages = { error: null, notice: null };

/** Posts an error, replacing an earlier one. */
export function postError(state: ReaderMessages, error: ReaderError, now: number): ReaderMessages {
  return { ...state, error: { error, at: now } };
}

/** Posts a notice with Undo, replacing an earlier one; its 8 seconds start now. */
export function postNotice(state: ReaderMessages, notice: ReaderNotice, now: number): ReaderMessages {
  return { ...state, notice: { notice, at: now } };
}

/** An error dismissed or retried; with `which`, only while that error is still the one posted. */
export function clearError(state: ReaderMessages, which?: ReaderError): ReaderMessages {
  if (!state.error || (which && state.error.error !== which)) return state;
  return { ...state, error: null };
}

/** A notice answered with Undo, or gone; with `which`, only while that notice is still the one posted. */
export function clearNotice(state: ReaderMessages, which?: ReaderNotice): ReaderMessages {
  if (!state.notice || (which && state.notice.notice !== which)) return state;
  return { ...state, notice: null };
}

/** The next tap on a control (any but the message's own buttons) ends a notice; what needs an answer stays. */
export function controlTapped(state: ReaderMessages): ReaderMessages {
  return clearNotice(state);
}

const noticeDue = (state: ReaderMessages, now: number) => !!state.notice && now - state.notice.at < NOTICE_MS;

/** Drops a notice whose 8 seconds are over. */
export function expire(state: ReaderMessages, now: number): ReaderMessages {
  return state.notice && !noticeDue(state, now) ? clearNotice(state) : state;
}

/** Milliseconds until the notice leaves by itself, or null with no notice due. */
export function noticeLeavesIn(state: ReaderMessages, now: number): number | null {
  return noticeDue(state, now) ? state.notice!.at + NOTICE_MS - now : null;
}

/**
 * The one message to show: a place saved elsewhere, then an error, then Back to narration's locating while it runs,
 * then a notice with Undo, then an update. The locating line is a status of the reader's own: it waits behind what
 * needs an answer, and its own failure is the error that replaces it.
 */
export function messageToShow(state: ReaderMessages, context: MessageContext): ReaderMessage | null {
  if (context.conflict) return { kind: "conflict", chapter: context.conflict.chapter };
  if (state.error) return { kind: "error", error: state.error.error };
  if (context.locating) return { kind: "locating" };
  if (state.notice && noticeDue(state, context.now)) return { kind: "notice", notice: state.notice.notice };
  if (context.update && !context.playing) return { kind: "update", build: context.update };
  return null;
}

const errorTexts: Record<ReaderError, string> = {
  narration: "The narrated sentence could not be shown.",
  locate: "The place in the text could not be found.",
  "bookmark-save": "The bookmark could not be saved.",
  "bookmark-remove": "The bookmark could not be removed.",
  "no-sync": "No reading sync is available for this position.",
  // Listen from here on a sentence the open map does not cover, or with no map for this ebook.
  "no-map": "Prepare a matching audiobook map for this passage first.",
  // Back to narration while the player holds no recording of this book.
  "no-recording": "Choose this recording and prepare its reading sync first.",
};

const noticeTexts: Record<ReaderNotice, string> = {
  listening: "Listening from here",
  "bookmark-removed": "Bookmark removed",
};

/** The message's sentence, in Label. */
export function messageText(message: ReaderMessage): string {
  switch (message.kind) {
    case "locating":
      return "Finding the place in the text…";
    case "conflict":
      return message.chapter ? `A place in ${message.chapter} was saved elsewhere.` : "A place in this book was saved elsewhere.";
    case "error":
      return errorTexts[message.error];
    case "notice":
      return noticeTexts[message.notice];
    case "update":
      return "An update is ready.";
  }
}

/** Whether an error offers Retry: where trying again can help (showing or finding the narrated place). */
export function errorRetries(error: ReaderError) {
  return error === "narration" || error === "locate";
}
