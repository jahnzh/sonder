// The Series page's model (#562, spec #560 "The Series page"), with plain data: the intro line, each row's line
// (a failure first, a place, a book on its way, not in the library, not released yet, needs the administrator for
// each role), Add, Retry and the chevron, the book to continue, related works and the refresh error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEW_MARK, seriesPageModel, withoutNew, type SeriesPageSeries, type SeriesPageWork } from "../src/pages/series-model.ts";
import {
  NEEDS_ADMIN_LINE,
  NO_AUDIOBOOK_LINE,
  NO_CONNECTION_LINE,
  NOT_IN_LIBRARY_LINE,
  NOT_RELEASED_LINE,
  SERIES_SEARCH_FAILED_LINE,
  SEVERAL_MATCHES_LINE,
} from "../src/status-lines.ts";
import type { LibraryWork, Progress, SeriesWorkAcquisition, Track, WorkRecording } from "../src/types.ts";

const track = (recordingId: string, index: number, duration = 600): Track => ({
  id: `${recordingId}-track-${index}`,
  recordingId,
  title: `Track ${index}`,
  index,
  duration,
  source: "",
  sourceType: "local",
});
const place = (recordingId: string, trackIndex: number, position: number, updatedAt = 1000): Progress => ({
  recordingId,
  trackId: `${recordingId}-track-${trackIndex}`,
  position,
  duration: 600,
  updatedAt,
});
function recording(recordingId: string, progress: Progress | null = null): WorkRecording {
  const tracks = [track(recordingId, 1), track(recordingId, 2), track(recordingId, 3)];
  return {
    recordingId,
    editionId: `${recordingId}-edition`,
    narrator: "",
    language: "English",
    releaseTitle: null,
    sourceLabel: "Local",
    cover: "",
    duration: 1800,
    tracks,
    serverStored: true,
    faults: {},
    progress,
    serverCopy: null,
  };
}
function libraryWork(workId: string, parts: Partial<LibraryWork> = {}): LibraryWork {
  return {
    workId,
    title: workId,
    author: "Iain M. Banks",
    description: "",
    genre: "",
    year: 2000,
    cover: `/covers/${workId}.jpg`,
    inLibrary: true,
    addedAt: 1,
    finished: false,
    completionOverride: null,
    chosenRecordingId: null,
    recordings: [recording(`${workId}-rec`)],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [],
    mediaState: null,
    hardcover: null,
    ...parts,
  };
}
const book = (id: string, position: number | null, parts: Partial<SeriesPageWork> = {}): SeriesPageWork => ({
  id,
  position,
  title: `Book ${id}`,
  cover: null,
  workId: `work-${id}`,
  unreleased: false,
  ...parts,
});
const series = (works: SeriesPageWork[], parts: Partial<SeriesPageSeries> = {}): SeriesPageSeries => ({
  id: "7",
  name: "The Culture",
  author: "Iain M. Banks",
  works,
  ...parts,
});
const libraryOf = (...works: LibraryWork[]) => new Map(works.map((work) => [work.workId, work]));
const facts = (library: Map<string, LibraryWork>, admin = false) => ({ library, admin, language: "en" });
const failed = (kind: "audio" | "ebook", error: string | null = null): SeriesWorkAcquisition =>
  ({ kind, status: "failed", error }) as SeriesWorkAcquisition;

test("the intro line counts finished books in the library over the books in the library or released", () => {
  const works = [book("1", 1), book("2", 2), book("3", 3), book("4", 4, { unreleased: true }), book("5", null)];
  const library = libraryOf(libraryWork("work-1", { finished: true }), libraryWork("work-2"));
  const model = seriesPageModel(series(works), facts(library));
  // 1 (finished), 2 (in the library), 3 (released): three counted; 4 is not out and not held; 5 is a related work.
  assert.equal(model.intro, "Iain M. Banks · 1 of 3 finished");
  assert.equal(model.title, "The Culture");
  // Without an author the counts stand alone.
  assert.equal(seriesPageModel(series(works, { author: null }), facts(library)).intro, "1 of 3 finished");
  // A place saved on this device at the end counts as finished before the server has it.
  const atEnd = libraryOf(libraryWork("work-1", { recordings: [recording("work-1-rec", place("work-1-rec", 3, 600))] }));
  assert.equal(seriesPageModel(series([book("1", 1)]), facts(atEnd)).intro, "Iain M. Banks · 1 of 1 finished");
});

test("one row per number: the book in the library stands at its number", () => {
  const works = [book("1", 1), book("11", 1, { title: "Other edition" }), book("2", 2)];
  const library = libraryOf(libraryWork("work-11"));
  const model = seriesPageModel(series(works), facts(library));
  assert.deepEqual(model.books.map((row) => [row.number, row.bookId]), [[1, "11"], [2, "2"]]);
});

test("each row's line: a failure first, then a place, then a book on its way, else Not started", () => {
  const inProgress = recording("work-1-rec", place("work-1-rec", 2, 100));
  const works = [
    // A failed series search wins over a place.
    book("1", 1, { acquisition: { audio: failed("audio"), ebook: null } }),
    book("2", 2),
    book("3", 3),
    book("4", 4),
    book("5", 5),
    book("6", 6),
    book("7", 7),
  ];
  const library = libraryOf(
    libraryWork("work-1", { recordings: [inProgress] }),
    libraryWork("work-2", { recordings: [recording("work-2-rec", place("work-2-rec", 2, 100))] }),
    libraryWork("work-3", { finished: true }),
    libraryWork("work-4", {
      recordings: [],
      mediaState: { state: "queued", holdReason: null, acquisition: { id: "a", status: "downloading", progress: 0.42, error: null } },
    }),
    libraryWork("work-5", { recordings: [], mediaState: { state: "queued", holdReason: null, acquisition: null } }),
    libraryWork("work-6", { recordings: [], mediaState: { state: "failed", holdReason: null, acquisition: null } }),
    libraryWork("work-7"),
  );
  const rows = seriesPageModel(series(works), facts(library)).books;
  assert.deepEqual(
    rows.map((row) => row.line),
    [
      // The failure names its search (#898).
      "Audiobook search failed",
      "Chapter 2 · 18 min left",
      "Finished",
      "Downloading to server · 42%",
      // A member does not see the acquisition: the download reads as Finding a source.
      "Finding a source",
      "Download failed",
      "Not started",
    ],
  );
  assert.equal(rows[3].progress, 0.42);
  assert.equal(rows[0].failed, true);
  assert.equal(rows[5].failed, true);
  assert.equal(rows[1].failed, false);
});

test("a series search on its way names itself", () => {
  const searching = { kind: "ebook", status: "searching" } as SeriesWorkAcquisition;
  const pending = { kind: "audio", status: "pending" } as SeriesWorkAcquisition;
  const library = libraryOf(libraryWork("work-1", { recordings: [] }), libraryWork("work-2", { recordings: [] }));
  const rows = seriesPageModel(
    series([book("1", 1, { acquisition: { audio: null, ebook: searching } }), book("2", 2, { acquisition: { audio: pending, ebook: null } })]),
    facts(library),
  ).books;
  assert.deepEqual(rows.map((row) => row.line), ["Searching for the ebook", "Waiting for series search"]);
});

test("a book with no audiobook yet reads No audiobook yet with Add; a row's label is the work's positionLabel", () => {
  const rows = seriesPageModel(
    series([book("1", 1), book("2", 2, { audiobook: false, positionLabel: "1.5" })]),
    facts(libraryOf(), true),
  ).books;
  assert.equal(NO_AUDIOBOOK_LINE, "No audiobook yet");
  assert.deepEqual(rows.map((row) => [row.line, row.label]), [[NOT_IN_LIBRARY_LINE, "1"], [NO_AUDIOBOOK_LINE, "1.5"]]);
  for (const row of rows) assert.deepEqual(row.action, { kind: "add" });
});

test("a book not in the library: Not in your library or Not released yet, with Add; New in front of a new one", () => {
  const rows = seriesPageModel(
    series([book("1", 1), book("2", 2, { unreleased: true }), book("3", 3, { new: true })]),
    facts(libraryOf()),
  ).books;
  assert.deepEqual(rows.map((row) => row.line), [NOT_IN_LIBRARY_LINE, NOT_RELEASED_LINE, `${NEW_MARK} · ${NOT_IN_LIBRARY_LINE}`]);
  for (const row of rows) {
    assert.deepEqual(row.action, { kind: "add" });
    assert.equal(row.workId, null, "not a link");
    assert.equal(row.chevron, false);
    assert.deepEqual(row.marks, []);
  }
  // A work another account holds, or one outside this account's library, is not a link for this account.
  const elsewhere = libraryOf(libraryWork("work-1", { inLibrary: false }));
  assert.equal(seriesPageModel(series([book("1", 1)]), facts(elsewhere)).books[0].workId, null);
});

test("needs the administrator: its line for each role, and no Add", () => {
  const works = [book("1", 1, { needsAdmin: true })];
  const member = seriesPageModel(series(works), facts(libraryOf(), false)).books[0];
  const admin = seriesPageModel(series(works), facts(libraryOf(), true)).books[0];
  assert.equal(member.line, NEEDS_ADMIN_LINE);
  assert.equal(admin.line, SEVERAL_MATCHES_LINE);
  assert.equal(member.action, null);
  assert.equal(admin.action, null);
  assert.equal(member.workId, null);
});

test("Retry: each failed series search kind, or the download; the chevron only on a link without a button", () => {
  const works = [
    book("1", 1, { acquisition: { audio: failed("audio"), ebook: failed("ebook") } }),
    book("2", 2, { acquisition: { audio: null, ebook: failed("ebook") } }),
    // An ebook search refused for the account cannot be run again.
    book("3", 3, { acquisition: { audio: null, ebook: failed("ebook", "no_permission") } }),
    book("4", 4),
    book("5", 5),
  ];
  const library = libraryOf(
    libraryWork("work-1"),
    libraryWork("work-2"),
    // Finished, so it is not the book to continue (which would have the play button).
    libraryWork("work-3", { finished: true }),
    libraryWork("work-4", { recordings: [], mediaState: { state: "failed", holdReason: null, acquisition: null } }),
    libraryWork("work-5", { finished: true }),
  );
  const rows = seriesPageModel(series(works), facts(library)).books;
  assert.deepEqual(rows[0].action, { kind: "retry-search", kinds: ["audio", "ebook"] });
  assert.deepEqual(rows[1].action, { kind: "retry-search", kinds: ["ebook"] });
  // A refusal's code is no reason a person reads (#898).
  assert.equal(rows[2].line, "Ebook search failed");
  assert.equal(rows[2].action, null);
  assert.deepEqual(rows[3].action, { kind: "retry-download" });
  // A failed row still opens its book.
  assert.equal(rows[0].workId, "work-1");
  assert.equal(rows[0].chevron, false);
  assert.equal(rows[2].chevron, true);
  assert.equal(rows[4].chevron, true);
  assert.equal(rows[4].action, null);
});

// A failed or held media state is returned as stored while the work is playable (ADR 0011), so a book with audio
// offers no download retry, and an empty-search hold offers none either (#395; tests/work-media-retry.test.ts guarded
// this for src/work-media-state.ts until #609 deleted that module, which nothing imported).
test("Retry: no download retry for a book that has audio, nor for a hold", () => {
  const works = [book("1", 1), book("2", 2), book("3", 3)];
  const library = libraryOf(
    libraryWork("work-1", { finished: true, mediaState: { state: "failed", holdReason: null, acquisition: null } }),
    libraryWork("work-2", { recordings: [], mediaState: { state: "missing", holdReason: "empty_search", acquisition: null } }),
    libraryWork("work-3", { recordings: [], mediaState: { state: "missing", holdReason: "unreleased", acquisition: null } }),
  );
  const rows = seriesPageModel(series(works), facts(library)).books;
  for (const row of rows) assert.equal(row.action, null, row.workId ?? undefined);
  assert.equal(rows[0].failed, false);
});

test("the book to continue: the one in progress, else the first unfinished in the library with a recording, else none", () => {
  const works = [book("1", 1), book("2", 2), book("3", 3), book("4", 4)];
  // In progress: book 3 (listened to last of the two in progress).
  const inProgress = libraryOf(
    libraryWork("work-1", { finished: true }),
    libraryWork("work-2", { recordings: [recording("work-2-rec", place("work-2-rec", 2, 100, 1000))] }),
    libraryWork("work-3", { recordings: [recording("work-3-rec", place("work-3-rec", 2, 100, 5000))] }),
    libraryWork("work-4"),
  );
  const model = seriesPageModel(series(works), facts(inProgress));
  assert.deepEqual(model.continueWith, { bookId: "3", workId: "work-3" });
  assert.deepEqual(model.books[2].action, { kind: "play" });
  assert.equal(model.books[2].chevron, false);
  assert.equal(model.books.filter((row) => row.action?.kind === "play").length, 1);

  // None in progress: the first unfinished book in the library with a recording (book 2 has none, book 3 is not held).
  const unfinished = libraryOf(libraryWork("work-1", { finished: true }), libraryWork("work-2", { recordings: [] }), libraryWork("work-4"));
  assert.deepEqual(seriesPageModel(series(works), facts(unfinished)).continueWith, { bookId: "4", workId: "work-4" });

  // Everything finished, or nothing with a recording: none.
  const done = libraryOf(libraryWork("work-1", { finished: true }), libraryWork("work-2", { recordings: [] }));
  assert.equal(seriesPageModel(series(works), facts(done)).continueWith, null);

  // A book that needs a Retry is not the one to continue.
  const failing = libraryOf(libraryWork("work-1"));
  assert.equal(
    seriesPageModel(series([book("1", 1, { acquisition: { audio: failed("audio"), ebook: null } })]), facts(failing)).continueWith,
    null,
  );
});

test("related works: listed apart as rows without a number, not counted", () => {
  const works = [book("1", 1), book("8", null, { title: "Companion" }), book("9", null, { title: "Notes", new: true })];
  const library = libraryOf(libraryWork("work-8", { finished: true }));
  const model = seriesPageModel(series(works), facts(library));
  assert.deepEqual(model.books.map((row) => row.bookId), ["1"]);
  assert.deepEqual(model.related.map((row) => [row.bookId, row.number, row.line]), [
    ["8", null, "Finished"],
    ["9", null, `${NEW_MARK} · ${NOT_IN_LIBRARY_LINE}`],
  ]);
  assert.equal(model.related[0].workId, "work-8");
  // Finished related work does not count: 0 of 1.
  assert.equal(model.intro, "Iain M. Banks · 0 of 1 finished");
});

test("the marks of a book in the library", () => {
  const library = libraryOf(
    libraryWork("work-1", {
      ebooks: [{ id: "e1", format: "epub", size: 1, available: true, check: null, place: null }],
    }),
  );
  assert.deepEqual(seriesPageModel(series([book("1", 1)]), facts(library)).books[0].marks, ["audiobook", "ebook"]);
});

test("the refresh error", () => {
  assert.equal(seriesPageModel(series([book("1", 1)]), facts(libraryOf())).refreshError, null);
  const message = "Add your Hardcover API token in Settings, then retry.";
  const model = seriesPageModel(series([book("1", 1)], { refreshError: message }), facts(libraryOf()));
  assert.equal(model.refreshError, message);
  // The last saved list is still shown.
  assert.equal(model.books.length, 1);
});

test("the Series page's words in the status-line module (#494)", () => {
  assert.equal(NOT_RELEASED_LINE, "Not released yet");
  assert.equal(SERIES_SEARCH_FAILED_LINE, "Series search failed");
  assert.equal(NEEDS_ADMIN_LINE, "Needs the administrator to link it");
  assert.equal(SEVERAL_MATCHES_LINE, "Matches more than one book on the server");
  assert.equal(NOT_IN_LIBRARY_LINE, "Not in your library");
});

// The New mark and the New card (#565, spec #560 "The Series page"; boards SeriesNew.dc.html, SeriesMore.dc.html).

test("the New line: New leads the line of every work the answer marks new, numbered or related, in the library or not", () => {
  const works = [
    book("1", 1),
    book("2", 2, { new: true }),
    book("3", 3, { new: true, unreleased: true }),
    book("4", 4, { new: true }),
    book("9", null, { title: "Drawings", new: true }),
  ];
  const model = seriesPageModel(series(works), facts(libraryOf(libraryWork("work-4"))));
  assert.deepEqual(
    [...model.books, ...model.related].map((row) => [row.line, row.status, row.isNew]),
    [
      [NOT_IN_LIBRARY_LINE, NOT_IN_LIBRARY_LINE, false],
      [`${NEW_MARK} · ${NOT_IN_LIBRARY_LINE}`, NOT_IN_LIBRARY_LINE, true],
      [`${NEW_MARK} · ${NOT_RELEASED_LINE}`, NOT_RELEASED_LINE, true],
      [`${NEW_MARK} · Not started`, "Not started", true],
      [`${NEW_MARK} · ${NOT_IN_LIBRARY_LINE}`, NOT_IN_LIBRARY_LINE, true],
    ],
  );
  assert.equal(NEW_MARK, "New");
  // A new work keeps its Add: the mark changes the line only.
  assert.deepEqual(model.books[1].action, { kind: "add" });
});

test("the New card: the new titles in reading order, comma-separated, and every new work for Dismiss", () => {
  const works = [
    book("9", null, { title: "The Culture: The Drawings", new: true }),
    book("4", 4, { title: "The State of the Art", new: true }),
    book("1", 1, { title: "Consider Phlebas" }),
    book("10", 10, { title: "The Hydrogen Sonata", new: true }),
  ];
  const card = seriesPageModel(series(works), facts(libraryOf())).newCard;
  assert.deepEqual(card, {
    titles: "The State of the Art, The Hydrogen Sonata, The Culture: The Drawings",
    bookIds: ["9", "4", "10"],
  });
});

test("the New card acknowledges a new translation that stands at no row, and names only the rows", () => {
  const works = [
    book("1", 1, { title: "English first", language: "en", new: true }),
    book("2", 1, { title: "Premier", language: "fr", new: true }),
  ];
  const card = seriesPageModel(series(works), facts(libraryOf())).newCard;
  assert.equal(card?.titles, "English first");
  assert.deepEqual(card?.bookIds, ["1", "2"]);
});

test("no card without new works; Dismiss clears the card and the marks", () => {
  assert.equal(seriesPageModel(series([book("1", 1), book("2", null)]), facts(libraryOf())).newCard, null);
  // A new translation that stands at no row alone: no row is marked, so no card.
  const hidden = [book("1", 1, { title: "English first", language: "en" }), book("2", 1, { title: "Premier", language: "fr", new: true })];
  assert.equal(seriesPageModel(series(hidden), facts(libraryOf())).newCard, null);
  const answer = series([book("1", 1, { new: true }), book("9", null, { new: true })]);
  const cleared = seriesPageModel(withoutNew(answer), facts(libraryOf()));
  assert.equal(cleared.newCard, null);
  assert.deepEqual([...cleared.books, ...cleared.related].map((row) => [row.line, row.isNew]), [
    [NOT_IN_LIBRARY_LINE, false],
    [NOT_IN_LIBRARY_LINE, false],
  ]);
  // The answer itself is not changed.
  assert.equal(answer.works[0].new, true);
});

// #568 (spec #560 "Without a connection"): the series this device kept, shown without a connection.
test("no connection: the No connection card where the refresh error would stand; Add, Retry, Dismiss and Remove series off", () => {
  const works = [
    book("1", 1, { title: "In progress" }),
    book("2", 2, { title: "Failed search", acquisition: { audio: null, ebook: failed("ebook") } }),
    book("3", 3, { title: "Missing", workId: null, new: true }),
    book("4", null, { title: "Companion", workId: null }),
  ];
  const library = libraryOf(
    libraryWork("work-1", { recordings: [recording("work-1-rec", place("work-1-rec", 2, 100))] }),
    libraryWork("work-2"),
  );
  const answer = series(works, { refreshError: "Hardcover could not be reached. Showing the last saved list." });

  const online = seriesPageModel(answer, facts(library));
  assert.equal(online.noConnection, null);
  assert.equal(online.refreshError, "Hardcover could not be reached. Showing the last saved list.");
  assert.equal(online.removeOff, false);
  assert.equal(online.dismissOff, false);
  assert.deepEqual([...online.books, ...online.related].map((row) => [row.title, row.action?.kind ?? null, row.actionOff]), [
    ["In progress", "play", false],
    ["Failed search", "retry-search", false],
    ["Missing", "add", false],
    ["Companion", "add", false],
  ]);

  const offline = seriesPageModel(answer, { ...facts(library), offline: true });
  // The card: "No connection", and no refresh error card (the stored answer's error is not this read's).
  assert.equal(offline.noConnection, NO_CONNECTION_LINE);
  assert.equal(NO_CONNECTION_LINE, "No connection");
  assert.equal(offline.refreshError, null);
  // Buttons off: Add, Retry, Dismiss and Remove series; the play button is not a request to the server and stays on.
  assert.equal(offline.removeOff, true);
  assert.equal(offline.dismissOff, true);
  assert.deepEqual([...offline.books, ...offline.related].map((row) => [row.title, row.action?.kind ?? null, row.actionOff]), [
    ["In progress", "play", false],
    ["Failed search", "retry-search", true],
    ["Missing", "add", true],
    ["Companion", "add", true],
  ]);
  // The books' lines are the same as with a connection, from the library by work on the device.
  assert.deepEqual(
    [...offline.books, ...offline.related].map((row) => row.line),
    [...online.books, ...online.related].map((row) => row.line),
  );
  assert.equal(offline.intro, online.intro);
  assert.deepEqual(offline.newCard, online.newCard);
  // A row without a button keeps its chevron; nothing is off that has no button.
  const plain = seriesPageModel(series([book("5", 1)]), { ...facts(libraryOf(libraryWork("work-5", { recordings: [] }))), offline: true });
  assert.deepEqual(plain.books.map((row) => [row.chevron, row.actionOff]), [[true, false]]);
});

// The series queue on the Series page (#898).
const state = (kind: "audio" | "ebook", parts: Partial<SeriesWorkAcquisition>): SeriesWorkAcquisition =>
  ({ kind, status: "done", error: null, skipReason: null, ...parts }) as SeriesWorkAcquisition;

test("each row names its search's state: waiting with its place, skipped, stopped, nothing found, left to choose, on server", () => {
  const noAudio = { recordings: [] };
  const works = [
    book("1", 1, { acquisition: { audio: state("audio", { status: "pending", place: 3 }), ebook: null } }),
    book("2", 2, { acquisition: { audio: state("audio", { status: "skipped", skipReason: "owner" }), ebook: null } }),
    book("3", 3, { acquisition: { audio: state("audio", { status: "skipped", skipReason: "stopped" }), ebook: null } }),
    book("4", 4, { acquisition: { audio: state("audio", { found: 0, chosen: false }), ebook: null } }),
    book("5", 5, { acquisition: { audio: state("audio", { found: 3, chosen: false }), ebook: null } }),
    book("6", 6, { acquisition: { audio: state("audio", { found: 3, chosen: true }), ebook: null } }),
    book("7", 7, { acquisition: { audio: state("audio", { found: 3, chosen: true }), ebook: null } }),
    book("8", 8, { acquisition: { audio: state("audio", { status: "failed", error: "AudioBookBay could not be reached. Try another mirror." }), ebook: null } }),
  ];
  const streams = { ...recording("work-7-rec"), serverStored: false };
  const library = libraryOf(
    libraryWork("work-1", noAudio),
    libraryWork("work-2", noAudio),
    libraryWork("work-3", noAudio),
    libraryWork("work-4", { ...noAudio, mediaState: { state: "missing", holdReason: "empty_search", acquisition: null } }),
    libraryWork("work-5", noAudio),
    libraryWork("work-6"),
    libraryWork("work-7", { recordings: [streams] }),
    libraryWork("work-8", noAudio),
  );
  const rows = seriesPageModel(series(works), facts(library, true)).books;
  assert.deepEqual(rows.map((row) => row.line), [
    "Waiting · 3rd in line",
    "Skipped",
    "Search stopped",
    "Nothing found",
    "3 found · choose one",
    "On server",
    "Streams from TorBox",
    "Audiobook search failed · AudioBookBay could not be reached",
  ]);
  // The administrator's rows of books a series search was asked for open the book's search sheet.
  assert.ok(rows.every((row) => row.searchSheet));
  const member = seriesPageModel(series(works), facts(library, false)).books;
  assert.ok(member.every((row) => !row.searchSheet));
});

test("the run line: the search running now, how many wait, when the next starts; Stop searching and Resume", () => {
  const works = [book("1", 1, { positionLabel: "1" }), book("3", 3), book("x", null, { title: "A Companion" })];
  const library = libraryOf(libraryWork("work-1"), libraryWork("work-3"), libraryWork("work-x"));
  const run = (queue: Partial<NonNullable<SeriesPageSeries["queue"]>>, elapsed = 0, admin = true) =>
    seriesPageModel(
      series(works, { queue: { searching: null, otherSearching: false, waiting: 0, retrying: 0, stopped: 0, nextAt: null, paused: false, now: 1000, ...queue } }),
      { ...facts(library, admin), elapsed },
    ).run;
  assert.deepEqual(run({ searching: { bookId: "3", kind: "audio" }, waiting: 5 }), { line: "Searching for book 3 · audiobook · 5 waiting", stop: true, resume: false });
  assert.equal(run({ searching: { bookId: "x", kind: "ebook" }, waiting: 0 })?.line, "Searching for A Companion · ebook");
  assert.equal(run({ waiting: 2, nextAt: 26_000 })?.line, "Next search in 25 s · 2 waiting");
  // The count goes on between reads of the series.
  assert.equal(run({ waiting: 2, nextAt: 26_000 }, 20_000)?.line, "Next search in 5 s · 2 waiting");
  assert.equal(run({ waiting: 2, otherSearching: true })?.line, "Another series is being searched · 2 waiting");
  assert.equal(run({ waiting: 2, paused: true })?.line, "Paused · 2 waiting");
  assert.equal(run({ waiting: 1, retrying: 1 })?.line, "1 waiting to try again");
  assert.deepEqual(run({ stopped: 4 }), { line: "Search stopped · 4 not searched", stop: false, resume: true });
  assert.equal(run({}), null);
  // A member has none; nor has an older server's answer.
  assert.equal(run({ waiting: 2 }, 0, false), null);
  assert.equal(seriesPageModel(series(works), facts(library, true)).run, null);
});
