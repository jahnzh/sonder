import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTICE_MS,
  clearError,
  clearNotice,
  controlTapped,
  errorRetries,
  expire,
  messageText,
  messagePlace,
  messageToShow,
  noMessages,
  noticeLeavesIn,
  postError,
  postNotice,
  type MessageContext,
  type ReaderMessage,
} from "../src/reader-messages";
// The reader's messages in the foot (#591, spec #586 "Messages in the foot"). The clock is a number passed in.

const at = (now: number, extra: Partial<MessageContext> = {}): MessageContext => ({
  now,
  playing: false,
  conflict: null,
  update: null,
  ...extra,
});

test("no message with nothing posted", () => {
  assert.equal(messageToShow(noMessages, at(0)), null);
});

test("each kind shows on its own, with its sentence", () => {
  const conflict = messageToShow(noMessages, at(0, { conflict: { chapter: "Letter 4" } }));
  assert.deepEqual(conflict, { kind: "conflict", chapter: "Letter 4" });
  assert.equal(messageText(conflict!), "A place in Letter 4 was saved elsewhere.");
  assert.equal(
    messageText(messageToShow(noMessages, at(0, { conflict: { chapter: "" } }))!),
    "A place in this book was saved elsewhere.",
  );

  const locating = messageToShow(noMessages, at(0, { locating: true }));
  assert.deepEqual(locating, { kind: "locating" });
  assert.equal(messageText(locating!), "Finding the place in the text…");

  const narration = messageToShow(postError(noMessages, "narration", 0), at(0));
  assert.deepEqual(narration, { kind: "error", error: "narration" });
  assert.equal(messageText(narration!), "The narrated sentence could not be shown.");
  assert.equal(messageText({ kind: "error", error: "bookmark-save" }), "The bookmark could not be saved.");
  assert.equal(messageText({ kind: "error", error: "bookmark-remove" }), "The bookmark could not be removed.");
  assert.equal(messageText({ kind: "error", error: "locate" }), "The place in the text could not be found.");

  const listening = messageToShow(postNotice(noMessages, "listening", 0), at(0));
  assert.deepEqual(listening, { kind: "notice", notice: "listening" });
  assert.equal(messageText(listening!), "Listening from here");
  assert.equal(messageText({ kind: "notice", notice: "bookmark-removed" }), "Bookmark removed");

  const update = messageToShow(noMessages, at(0, { update: "build-2" }));
  assert.deepEqual(update, { kind: "update", build: "build-2" });
  assert.equal(messageText(update!), "An update is ready.");
});

test("Retry only where retrying helps: showing or finding the narrated place, not a refused bookmark", () => {
  assert.equal(errorRetries("narration"), true);
  assert.equal(errorRetries("locate"), true);
  assert.equal(errorRetries("bookmark-save"), false);
  assert.equal(errorRetries("bookmark-remove"), false);
});

test("when two are due: a place saved elsewhere, then an error, then a notice, then an update", () => {
  let state = postNotice(noMessages, "listening", 0);
  state = postError(state, "bookmark-save", 1);
  const all = at(2, { conflict: { chapter: "Letter 4" }, update: "build-2" });
  assert.equal(messageToShow(state, all)?.kind, "conflict");
  assert.equal(messageToShow(state, { ...all, conflict: null })?.kind, "error");
  assert.equal(messageToShow(clearError(state), { ...all, conflict: null })?.kind, "notice");
  assert.equal(messageToShow(clearNotice(clearError(state)), { ...all, conflict: null })?.kind, "update");
  // The one behind comes back once the one in front is answered.
  assert.equal(messageToShow(clearError(state), at(2, { update: "build-2" }))?.kind, "notice");
});

test("Back to narration's locating waits behind a conflict and an error, and goes before a notice and an update", () => {
  const notice = postNotice(noMessages, "listening", 0);
  const all = at(1, { locating: true, update: "build-2" });
  assert.equal(messageToShow(notice, { ...all, conflict: { chapter: "Letter 4" } })?.kind, "conflict");
  assert.equal(messageToShow(postError(notice, "locate", 1), all)?.kind, "error");
  assert.equal(messageToShow(notice, all)?.kind, "locating");
  assert.equal(messageToShow(noMessages, all)?.kind, "locating");
  // Once it ends, what waited behind it shows again.
  assert.equal(messageToShow(notice, { ...all, locating: false })?.kind, "notice");
  assert.equal(messageToShow(noMessages, { ...all, locating: false })?.kind, "update");
});

test("a newer message of the same kind replaces the older one", () => {
  let state = postError(noMessages, "narration", 0);
  state = postError(state, "bookmark-remove", 10);
  assert.deepEqual(messageToShow(state, at(10)), { kind: "error", error: "bookmark-remove" });
  // Dismissing it leaves no older error behind.
  assert.equal(messageToShow(clearError(state), at(10)), null);

  state = postNotice(noMessages, "listening", 0);
  state = postNotice(state, "bookmark-removed", 5000);
  assert.deepEqual(messageToShow(state, at(5000)), { kind: "notice", notice: "bookmark-removed" });
  // The newer notice has its own 8 seconds.
  assert.equal(messageToShow(state, at(5000 + NOTICE_MS - 1))?.kind, "notice");
  assert.equal(messageToShow(state, at(5000 + NOTICE_MS)), null);
});

test("clearing names the message it answers: a newer one of the kind stays", () => {
  const state = postError(noMessages, "bookmark-save", 0);
  assert.equal(clearError(state, "narration"), state);
  assert.equal(clearError(state, "bookmark-save").error, null);
  const notice = postNotice(noMessages, "bookmark-removed", 0);
  assert.equal(clearNotice(notice, "listening"), notice);
  assert.equal(clearNotice(notice, "bookmark-removed").notice, null);
});

test("a notice leaves after 8 seconds by the injected clock", () => {
  const state = postNotice(noMessages, "listening", 1000);
  assert.equal(NOTICE_MS, 8000);
  assert.equal(noticeLeavesIn(state, 1000), 8000);
  assert.equal(noticeLeavesIn(state, 8999), 1);
  assert.equal(messageToShow(state, at(8999))?.kind, "notice");
  assert.equal(messageToShow(state, at(9000)), null);
  assert.equal(noticeLeavesIn(state, 9000), null);
  assert.equal(expire(state, 8999), state);
  assert.equal(expire(state, 9000).notice, null);
});

test("the next tap on a control ends a notice, not a message that needs an answer", () => {
  const notice = postNotice(noMessages, "bookmark-removed", 0);
  assert.equal(messageToShow(controlTapped(notice), at(1)), null);
  const error = postError(noMessages, "narration", 0);
  assert.deepEqual(messageToShow(controlTapped(error), at(1)), { kind: "error", error: "narration" });
  // A conflict and an update are outside the posted state: a tap leaves them.
  assert.equal(messageToShow(controlTapped(notice), at(1, { conflict: { chapter: "" } }))?.kind, "conflict");
  assert.equal(messageToShow(controlTapped(notice), at(1, { update: "b" }))?.kind, "update");
});

test("a tap ends only the notice shown when it was tapped, not a newer one the control posted", () => {
  const listening = postNotice(noMessages, "listening", 0);
  // The head's bookmark button removed one: its own notice is newer than the tap's.
  const removed = postNotice(listening, "bookmark-removed", 1);
  assert.equal(controlTapped(removed, listening.notice), removed);
  assert.equal(messageToShow(controlTapped(removed, listening.notice), at(2))?.kind, "notice");
  // A newer notice of the same kind is newer too.
  assert.equal(controlTapped(postNotice(listening, "listening", 1), listening.notice).notice?.at, 1);
  // The notice seen is still the one shown: it ends.
  assert.equal(controlTapped(listening, listening.notice).notice, null);
});

test("errors and a place saved elsewhere stay until answered, however long", () => {
  const state = postError(noMessages, "bookmark-save", 0);
  assert.equal(messageToShow(state, at(10 * 60_000))?.kind, "error");
  assert.equal(expire(state, 10 * 60_000), state);
  assert.equal(messageToShow(noMessages, at(10 * 60_000, { conflict: { chapter: "x" } }))?.kind, "conflict");
});

test("an update is held while the narration plays and shown once it is paused", () => {
  assert.equal(messageToShow(noMessages, at(0, { update: "build-2", playing: true })), null);
  assert.deepEqual(messageToShow(noMessages, at(0, { update: "build-2", playing: false })), { kind: "update", build: "build-2" });
  // While it plays a notice still shows; once paused and the notice gone, the update.
  const notice = postNotice(noMessages, "listening", 0);
  assert.equal(messageToShow(notice, at(1, { update: "build-2", playing: true }))?.kind, "notice");
  assert.equal(messageToShow(notice, at(NOTICE_MS, { update: "build-2", playing: true })), null);
  assert.equal(messageToShow(notice, at(NOTICE_MS, { update: "build-2", playing: false }))?.kind, "update");
});

// #591 fix: a long-press with no matching map, and Back to narration with no recording of this book, said their own
// sentence in the app's toast; in the foot they keep it (the reader-frame specs look for the long-press one).
test("a long-press without a matching map asks for one in the foot, until dismissed", () => {
  const posted = postError(noMessages, "no-map", 0);
  const shown = messageToShow(posted, at(60_000, { playing: true }));
  assert.deepEqual(shown, { kind: "error", error: "no-map" });
  assert.equal(messageText(shown!), "Prepare a matching audiobook map for this passage first.");
  assert.equal(errorRetries("no-map"), false);
  // An error needs an answer: neither the clock nor the next tap on a control takes it away, paused or playing.
  assert.deepEqual(messageToShow(controlTapped(expire(posted, 60_000)), at(60_000)), shown);
  assert.equal(messageToShow(clearError(posted, "no-map"), at(0)), null);
  assert.equal(
    messageText({ kind: "error", error: "no-recording" }),
    "Choose this recording and prepare its reading sync first.",
  );
  assert.notEqual(messageText({ kind: "error", error: "no-map" }), messageText({ kind: "error", error: "no-sync" }));
});

// Where a message goes (#890, ADR 0019 amended 2026-11-24).
const every: ReaderMessage[] = [
  { kind: "notice", notice: "listening" },
  { kind: "notice", notice: "bookmark-removed" },
  { kind: "error", error: "narration" },
  { kind: "error", error: "bookmark-save" },
  { kind: "conflict", chapter: "Chapter 2" },
  { kind: "locating" },
  { kind: "update", build: "b2" },
];

test("on a phone with the controls shown, a notice with Undo takes the timeline's row, so the transport row stays", () => {
  assert.equal(messagePlace({ kind: "notice", notice: "listening" }, { controls: true, desktop: false }), "timeline");
  assert.equal(messagePlace({ kind: "notice", notice: "bookmark-removed" }, { controls: true, desktop: false }), "timeline");
});

test("at rest a notice stands where it stood, in the lower row", () => {
  for (const notice of ["listening", "bookmark-removed"] as const)
    assert.equal(messagePlace({ kind: "notice", notice }, { controls: false, desktop: false }), "row");
});

test("the foot's other messages keep the row's place, at rest and with the controls shown", () => {
  for (const message of every.filter((value) => value.kind !== "notice"))
    for (const controls of [false, true])
      assert.equal(messagePlace(message, { controls, desktop: false }), "row", `${JSON.stringify(message)} controls ${controls}`);
});

test("on a desktop every message, the notice too, keeps the footer's row in this cut", () => {
  for (const message of every) assert.equal(messagePlace(message, { controls: true, desktop: true }), "row");
});
