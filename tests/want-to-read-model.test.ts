// Want to read's words and rows on the client (#721 part c1): the Book page's action, a Discover row's line and its
// action's name, the line after a tap, and the note each tap leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wantToReadAction } from "../src/pages/book-model.ts";
import { hardcoverRow, serverRow, wantToReadActionName, withWantToRead } from "../src/pages/discover-model.ts";
import { WANT_TO_READ, wantToReadNote } from "../src/status-lines.ts";
import type { WorkResult } from "../src/types.ts";

const result = (parts: Partial<WorkResult> = {}): WorkResult => ({
  workId: "w-1",
  title: "Piranesi",
  author: "Susanna Clarke",
  year: 2020,
  cover: "",
  inLibrary: false,
  hasAudiobook: true,
  hasEbook: false,
  hardcoverId: null,
  ...parts,
});

test("the Book page: a second button beside Add to library outside it, a row that puts it on or takes it off inside", () => {
  assert.deepEqual(wantToReadAction({ inLibrary: false }), { label: "Want to read", on: true });
  assert.deepEqual(wantToReadAction({ inLibrary: false, wantToRead: true }), { label: "Want to read", on: true });
  assert.deepEqual(wantToReadAction({ inLibrary: true, wantToRead: false }), { label: "Add to Want to read", on: true });
  assert.deepEqual(wantToReadAction({ inLibrary: true }), { label: "Add to Want to read", on: true });
  assert.deepEqual(wantToReadAction({ inLibrary: true, wantToRead: true }), { label: "Remove from Want to read", on: false });
});

test("a Discover row of the server says Want to read for a book on it, in place of In your library", () => {
  assert.equal(WANT_TO_READ, "Want to read");
  assert.deepEqual(serverRow(result({ inLibrary: true, wantToRead: true })), {
    workId: "w-1",
    title: "Piranesi",
    status: "Susanna Clarke · Want to read",
    cover: null,
    wantToRead: true,
  });
  assert.equal(serverRow(result({ inLibrary: true, wantToRead: false })).status, "Susanna Clarke · In your library");
  assert.equal(serverRow(result({ inLibrary: true, wantToRead: false })).wantToRead, false);
  // Want to read is a shelf of the library: a work outside it is never shown on it.
  assert.equal(serverRow(result({ inLibrary: false, wantToRead: true })).status, "Susanna Clarke · Audiobook");
  assert.equal(serverRow(result({ inLibrary: false, wantToRead: true })).wantToRead, false);
  // A server before this part sends no `wantToRead`.
  assert.equal(serverRow(result({ inLibrary: true })).wantToRead, false);
  assert.equal(serverRow(result()).status, "Susanna Clarke · Audiobook");
  // Hardcover's books are never on it before a tap.
  assert.equal(hardcoverRow({ document: { id: 5, title: "Lent", author_names: ["Jo Walton"], release_year: 2019 }, workId: "work-hc-5" }).wantToRead, false);
});

test("a row after a tap on its action, until the answers are read again", () => {
  const off = serverRow(result({ inLibrary: true }));
  const on = withWantToRead(off, true);
  assert.equal(on.wantToRead, true);
  assert.equal(on.status, "Susanna Clarke · Want to read");
  const offAgain = withWantToRead(on, false);
  assert.equal(offAgain.wantToRead, false);
  assert.equal(offAgain.status, "Susanna Clarke · In your library");
  // No tap: the row as it is. A tap off a book that was not in the library: it is now, and its line says so.
  assert.equal(withWantToRead(off, undefined), off);
  assert.deepEqual(withWantToRead(off, false), off);
  const outside = serverRow(result());
  assert.equal(outside.status, "Susanna Clarke · Audiobook");
  assert.equal(withWantToRead(withWantToRead(outside, true), false).status, "Susanna Clarke · In your library");
  assert.equal(withWantToRead(outside, false).status, "Susanna Clarke · In your library");
  const hit = hardcoverRow({ document: { id: 5, title: "Lent", author_names: ["Jo Walton"], release_year: 2019 }, workId: "work-hc-5" });
  assert.equal(withWantToRead(hit, true).status, "Jo Walton · Want to read");
});

test("the row's action is named by what it does and the book's title; each tap leaves a note", () => {
  assert.equal(wantToReadActionName({ title: "Piranesi", wantToRead: false }), "Add Piranesi to Want to read");
  assert.equal(wantToReadActionName({ title: "Piranesi", wantToRead: true }), "Remove Piranesi from Want to read");
  assert.equal(wantToReadNote(true), "Added to Want to read");
  assert.equal(wantToReadNote(false), "Removed from Want to read");
});
