// The Library's shelf by work (#577, spec #572 "The Library"): each chip, the shelf (#721 part c1), Search, the
// sorts, Continue, the list row's line, the empty shelf and the favourites migration, with plain data on a fixture of
// an EPUB-only, a PDF-only, a nothing-yet, a downloading, an in-progress, a finished and a favourite book.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_CHIP,
  chipLabel,
  continueShown,
  continueWork,
  emptyShelf,
  filterLibrary,
  LIBRARY_CHIPS,
  controlLabel,
  listLine,
  listRowLine,
  matchesSearch,
  NO_SHELF,
  readShelf,
  shelfChip,
  shelfChoices,
  underShelf,
  SORT_NAMES,
  SORT_ORDERS,
  progressFraction,
  readChip,
  readSort,
  readView,
  shelfHeading,
  sortLibrary,
  type LibraryChip,
  type ShelfInput,
} from "../src/pages/library-filter.ts";
import { EDITION_FAVORITES_KEY, migrateFavorites, toggleFavoriteWork, upgradeFavoritesToWorks, WORK_FAVORITES_KEY } from "../src/favorites-by-work.ts";
import { overlayDevicePlaces } from "../src/library-works-overlay.ts";
import type { LibraryWork, Progress, Track, WorkEbook, WorkRecording } from "../src/types.ts";

const track = (recordingId: string, index: number, duration = 600): Track => ({
  id: `${recordingId}-track-${index}`,
  recordingId,
  title: `Chapter ${index}`,
  index,
  duration,
  source: "",
  sourceType: "local",
});
const place = (recordingId: string, trackIndex: number, position: number, updatedAt: number): Progress => ({
  recordingId,
  trackId: `${recordingId}-track-${trackIndex}`,
  position,
  duration: 600,
  updatedAt,
});
function recording(recordingId: string, progress: Progress | null = null, tracks = [track(recordingId, 1), track(recordingId, 2)]): WorkRecording {
  return {
    recordingId,
    editionId: `${recordingId}-edition`,
    narrator: "Narrator",
    language: "en",
    releaseTitle: null,
    sourceLabel: "Local",
    cover: "",
    duration: tracks.reduce((sum, t) => sum + t.duration, 0),
    tracks,
    serverStored: true,
    faults: {},
    progress,
    serverCopy: null,
  };
}
const ebook = (id: string, format: "epub" | "pdf", placeAt: WorkEbook["place"] = null): WorkEbook => ({ id, format, size: 1000, available: true, check: null, place: placeAt });
const hardcover = (statusId: number | null, listIds: number[]): NonNullable<LibraryWork["hardcover"]> => ({
  id: 1,
  slug: null,
  series: [],
  statusId,
  pending: false,
  progressFraction: null,
  progressPending: false,
  syncError: null,
  listIds,
});
function work(workId: string, title: string, author: string, parts: Partial<LibraryWork> = {}): LibraryWork {
  return {
    workId,
    title,
    author,
    description: "",
    genre: "",
    year: 2000,
    cover: "",
    inLibrary: true,
    addedAt: 1,
    finished: false,
    completionOverride: null,
    chosenRecordingId: null,
    recordings: [],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [],
    mediaState: null,
    hardcover: null,
    ...parts,
  };
}

// The fixture: one of each kind the ticket names, and a book read in the reader (In progress by its ebook's place).
const epubOnly = work("w-epub", "Piranesi", "Susanna Clarke", { ebooks: [ebook("e-epub", "epub")], addedAt: 7, hardcover: hardcover(1, [10]), wantToRead: true });
const pdfOnly = work("w-pdf", "Capitalist Realism", "Mark Fisher", { ebooks: [ebook("e-pdf", "pdf")], addedAt: 6 });
const nothing = work("w-nothing", "Kindred", "Octavia E. Butler", { addedAt: 5, hardcover: hardcover(1, []), wantToRead: true });
const downloading = work("w-downloading", "Snow Crash", "Neal Stephenson", {
  addedAt: 4,
  mediaState: { state: "queued", holdReason: null, acquisition: { id: "a", status: "downloading", progress: 0.43, error: null } },
});
const listening = work("w-listening", "There Is No Antimemetics Division", "qntm", {
  recordings: [recording("r-listen", place("r-listen", 2, 120, 5000))],
  addedAt: 3,
  hardcover: hardcover(2, [10, 11]),
});
const readingEbook = work("w-reading", "Frankenstein", "Mary Shelley", {
  ebooks: [ebook("e-frank", "epub", { progression: 0.38, origin: "reading", updatedAt: 4000 })],
  addedAt: 2,
});
const finished = work("w-finished", "Matter", "Iain M. Banks", { recordings: [recording("r-matter")], finished: true, addedAt: 1, hardcover: hardcover(3, [11]) });
const favorite = work("w-favorite", "The Picture of Dorian Gray", "Oscar Wilde", { recordings: [recording("r-dorian")], addedAt: 0 });
const fixture = [epubOnly, pdfOnly, nothing, downloading, listening, readingEbook, finished, favorite];

const input = (parts: Partial<ShelfInput> = {}): ShelfInput => ({
  chip: ALL_CHIP,
  query: "",
  favorites: ["w-favorite", "w-pdf"],
  // Kept and complete on this device: the PDF and the finished audiobook.
  onDevice: new Set(["w-pdf", "w-finished"]),
  shelf: NO_SHELF,
  ...parts,
});
const ids = (works: LibraryWork[]) => works.map((w) => w.workId);
const under = (chip: LibraryChip, parts: Partial<ShelfInput> = {}) => ids(filterLibrary(fixture, input({ chip, ...parts })));

test("the chips in the boards' order, All shown as All and its heading All books", () => {
  assert.deepEqual([...LIBRARY_CHIPS].map(chipLabel), ["All", "Series", "In progress", "Not started", "Finished", "On device", "Favorites"]);
  assert.deepEqual([...LIBRARY_CHIPS].map(shelfHeading), ["All books", "Series", "In progress", "Not started", "Finished", "On device", "Favorites"]);
});

test("each chip on the fixture", () => {
  assert.deepEqual(under("All books"), ids(fixture));
  // Series shows the Series chip's list in place of the shelf: it leaves every work.
  assert.deepEqual(under("Series"), ids(fixture));
  // In progress: a place past the start of a recording, and a place in the ebook read in the reader.
  assert.deepEqual(under("In progress"), ["w-listening", "w-reading"]);
  // Not started: the EPUB-only, PDF-only, nothing-yet, downloading and favourite books.
  assert.deepEqual(under("Not started"), ["w-epub", "w-pdf", "w-nothing", "w-downloading", "w-favorite"]);
  assert.deepEqual(under("Finished"), ["w-finished"]);
  // On device: Keep on and complete, as the device's entries say; nothing else counts.
  assert.deepEqual(under("On device"), ["w-pdf", "w-finished"]);
  assert.deepEqual(under("Favorites"), ["w-pdf", "w-favorite"]);
  assert.deepEqual(under("Favorites", { favorites: [] }), []);
});

test("In progress counts this device's newer place laid over the stored work", () => {
  const device = overlayDevicePlaces(favorite, { listening: [place("r-dorian", 1, 30, 9000)], reading: [] });
  assert.deepEqual(ids(filterLibrary([favorite, device], input({ chip: "In progress" }))), ["w-favorite"]);
  assert.deepEqual(ids(filterLibrary([favorite], input({ chip: "In progress" }))), []);
});

test("the shelf narrows the books, and narrows with a chip: Want to read by the list, Reading and Finished by progress", () => {
  assert.deepEqual(under("All books", { shelf: "want-to-read" }), ["w-epub", "w-nothing"]);
  assert.deepEqual(under("All books", { shelf: "reading" }), ["w-listening", "w-reading"]);
  assert.deepEqual(under("All books", { shelf: "finished" }), ["w-finished"]);
  assert.deepEqual(under("Not started", { shelf: "want-to-read" }), ["w-epub", "w-nothing"]);
  assert.deepEqual(under("Favorites", { shelf: "want-to-read" }), []);
  assert.deepEqual(under("In progress", { shelf: "finished" }), []);
  // Hardcover's shelf of a work no longer decides anything: the listening book is on Hardcover's Currently reading.
  assert.equal(underShelf({ ...listening, wantToRead: false }, "want-to-read"), false);
  // A work stored by an older build has no `wantToRead`: it is not on Want to read.
  const { wantToRead: _, ...older } = epubOnly;
  assert.equal(underShelf(older as LibraryWork, "want-to-read"), false);
  assert.equal(underShelf(older as LibraryWork, "all"), true);
});

test("Search: every word in the title or the author, case and accents ignored", () => {
  assert.deepEqual(under("All books", { query: "frank" }), ["w-reading"]);
  assert.deepEqual(under("All books", { query: "MARY shelley" }), ["w-reading"]);
  assert.deepEqual(under("All books", { query: "  banks   matter " }), ["w-finished"]);
  assert.deepEqual(under("All books", { query: "fisher realism" }), ["w-pdf"]);
  assert.deepEqual(under("All books", { query: "fisher dorian" }), []);
  assert.deepEqual(under("All books", { query: "nowhere" }), []);
  assert.equal(matchesSearch({ title: "Les Misérables", author: "Victor Hugo" }, "miserables"), true);
  assert.equal(matchesSearch({ title: "Les Miserables", author: "Victor Hugo" }, "Misérables HUGO"), true);
  assert.equal(matchesSearch({ title: "x", author: "y" }, ""), true);
  // Search combines with the chip.
  assert.deepEqual(under("Finished", { query: "frank" }), []);
  assert.deepEqual(under("In progress", { query: "frank" }), ["w-reading"]);
});

test("the sorts: Recently added, Title, Author and Progress, ties by title", () => {
  assert.deepEqual(ids(sortLibrary(fixture, "recent")), ["w-epub", "w-pdf", "w-nothing", "w-downloading", "w-listening", "w-reading", "w-finished", "w-favorite"]);
  assert.deepEqual(sortLibrary(fixture, "title").map((w) => w.title), [
    "Capitalist Realism",
    "Frankenstein",
    "Kindred",
    "Matter",
    "Piranesi",
    "Snow Crash",
    "The Picture of Dorian Gray",
    "There Is No Antimemetics Division",
  ]);
  assert.deepEqual(sortLibrary(fixture, "author").map((w) => w.author), [
    "Iain M. Banks",
    "Mark Fisher",
    "Mary Shelley",
    "Neal Stephenson",
    "Octavia E. Butler",
    "Oscar Wilde",
    "qntm",
    "Susanna Clarke",
  ]);
  // Progress: Finished first, then the furthest place (720 of 1200 s = 60%, the ebook's 38%), then by title.
  assert.deepEqual(ids(sortLibrary(fixture, "progress")).slice(0, 3), ["w-finished", "w-listening", "w-reading"]);
  assert.deepEqual(sortLibrary(fixture, "progress").slice(3).map((w) => w.title), ["Capitalist Realism", "Kindred", "Piranesi", "Snow Crash", "The Picture of Dorian Gray"]);
  assert.equal(progressFraction(listening), 0.6);
  assert.equal(progressFraction(readingEbook), 0.38);
  // Ties: the same date added orders by title.
  const same = [work("b", "Beta", "A", { addedAt: 9 }), work("a", "Alpha", "A", { addedAt: 9 })];
  assert.deepEqual(ids(sortLibrary(same, "recent")), ["a", "b"]);
  assert.deepEqual(ids(sortLibrary(same, "author")), ["a", "b"]);
  // The input is not changed.
  assert.deepEqual(ids(same), ["b", "a"]);
});

test("progress never adds two recordings of one work together", () => {
  const two = work("w-two", "The Left Hand of Darkness", "Ursula K. Le Guin", {
    recordings: [recording("r-one", place("r-one", 2, 0, 10)), recording("r-two", place("r-two", 1, 300, 20))],
  });
  // r-one: 600 of 1200 = 0.5; r-two: 300 of 1200 = 0.25. The furthest one, not 0.75.
  assert.equal(progressFraction(two), 0.5);
});

test("Continue: the book in progress with the newest place, only on All with no filter and no search", () => {
  assert.equal(continueWork(fixture)?.workId, "w-listening");
  // The ebook's place is newer: the book read in the reader.
  const newer = work("w-reading", "Frankenstein", "Mary Shelley", { ebooks: [ebook("e-frank", "epub", { progression: 0.4, origin: "reading", updatedAt: 9000 })] });
  assert.equal(continueWork([listening, newer])?.workId, "w-reading");
  // A finished book with a newer place is not continued, nor one not started.
  const finishedLater = work("w-done", "Done", "A", { recordings: [recording("r-done", place("r-done", 2, 599.9, 99999))], finished: true });
  assert.equal(continueWork([finishedLater, listening])?.workId, "w-listening");
  assert.equal(continueWork([pdfOnly, nothing, favorite]), null);
  assert.equal(continueShown(ALL_CHIP, "", "all"), true);
  assert.equal(continueShown("In progress", "", "all"), false);
  assert.equal(continueShown(ALL_CHIP, "frank", "all"), false);
  assert.equal(continueShown(ALL_CHIP, "  ", "all"), true);
  assert.equal(continueShown(ALL_CHIP, "", "want-to-read"), false);
  assert.equal(continueShown(ALL_CHIP, "", "reading"), false);
});

test("the list row's line: each place line, and the download's line while the first file is on its way", () => {
  assert.equal(listLine(nothing), "Not started");
  assert.equal(listLine(pdfOnly), "Not started");
  assert.equal(listLine(readingEbook), "38% of the ebook");
  assert.equal(listLine(listening), "Chapter 2 · 8 min left");
  assert.equal(listLine(finished), "Finished");
  assert.equal(listLine(downloading), "Downloading to server · 43%");
});

test("an empty shelf: No books with what is in use and Clear filters; an empty library: No books yet and Find a book", () => {
  assert.deepEqual(emptyShelf(0, input()), { title: "No books yet", inUse: [], action: "find" });
  assert.deepEqual(emptyShelf(8, input({ chip: "Finished" })), { title: "No books", inUse: ["Finished"], action: "clear" });
  assert.deepEqual(emptyShelf(8, input({ chip: "Favorites", query: " frank ", shelf: "want-to-read" })), {
    title: "No books",
    inUse: ["Favorites", "Want to read", "“frank”"],
    action: "clear",
  });
  assert.deepEqual(emptyShelf(8, input({ shelf: "finished" })).inUse, ["Finished"]);
});

test("the chip, sort and view read back from the device; earlier values map to their chips", () => {
  for (const chip of LIBRARY_CHIPS) assert.equal(readChip(chip), chip);
  assert.equal(readChip(null), "All books");
  assert.equal(readChip("Something else"), "All books");
  assert.equal(readChip("Listening"), "In progress");
  assert.equal(readChip("Downloaded"), "On device");
  assert.equal(readSort("author"), "author");
  assert.equal(readSort("bogus"), "recent");
  assert.equal(readView("list"), "list");
  assert.equal(readView(undefined), "grid");
});

test("the favourites migration: edition ids to work ids, placeholders included, unknown ids dropped", () => {
  const books = [
    { id: "edition-left-1", workId: "work-left" },
    { id: "edition-left-2", workId: "work-left" },
    // A placeholder edition (#555): a book with nothing yet is in the books table too.
    { id: "placeholder-kindred", workId: "work-kindred" },
    { id: "edition-alice", workId: "work-alice" },
  ];
  assert.deepEqual(migrateFavorites(["edition-left-2", "unknown", "placeholder-kindred", "edition-left-1", 7, null], books), ["work-left", "work-kindred"]);
  assert.deepEqual(migrateFavorites([], books), []);
  assert.deepEqual(migrateFavorites(["edition-alice"], []), []);
});

test("the upgrade writes the favourites by work once, and leaves the old preference for an older tab", async () => {
  const rows = new Map<string, { key: string; value: unknown }>([[EDITION_FAVORITES_KEY, { key: EDITION_FAVORITES_KEY, value: ["e1", "ph", "gone"] }]]);
  const preferences = {
    get: async (key: string) => rows.get(key),
    put: async (row: { key: string; value: unknown }) => void rows.set(row.key, row),
  };
  const books = { toArray: async () => [{ id: "e1", workId: "w1" }, { id: "ph", workId: "w2" }] };
  await upgradeFavoritesToWorks(preferences, books);
  assert.deepEqual(rows.get(WORK_FAVORITES_KEY)?.value, ["w1", "w2"]);
  assert.deepEqual(rows.get(EDITION_FAVORITES_KEY)?.value, ["e1", "ph", "gone"]);
  // Favourites by work already there are kept.
  rows.set(WORK_FAVORITES_KEY, { key: WORK_FAVORITES_KEY, value: ["w9"] });
  await upgradeFavoritesToWorks(preferences, books);
  assert.deepEqual(rows.get(WORK_FAVORITES_KEY)?.value, ["w9"]);
  // No favourites before: nothing written.
  const empty = new Map<string, { key: string; value: unknown }>();
  await upgradeFavoritesToWorks({ get: async (key) => empty.get(key), put: async (row) => void empty.set(row.key, row) }, books);
  assert.equal(empty.size, 0);
});

test("the Book page's Favorite toggles the work", () => {
  assert.deepEqual(toggleFavoriteWork("w1", []), ["w1"]);
  assert.deepEqual(toggleFavoriteWork("w1", ["w0", "w1"]), ["w0"]);
  assert.deepEqual(toggleFavoriteWork("w2", ["w0"]), ["w0", "w2"]);
});

// The sort-and-view control (#578; boards LibrarySort.dc.html, LibraryShelf.dc.html, LibraryList.dc.html).

test("each sort with ties by title, from the picker's names", () => {
  assert.deepEqual(SORT_ORDERS.map((order) => SORT_NAMES[order]), ["Recently added", "Title", "Author", "Progress"]);
  // Two books alike in every order but their titles: each sort puts them by title, whichever came first.
  const twin = (id: string, title: string) => work(id, title, "Same Author", { addedAt: 3, recordings: [recording(`r-${id}`)] });
  const pair = [twin("b", "Zebra"), twin("a", "Aardvark")];
  for (const order of SORT_ORDERS) assert.deepEqual(sortLibrary(pair, order).map((w) => w.title), ["Aardvark", "Zebra"], order);
  assert.deepEqual(sortLibrary(fixture, "title").map((w) => w.title), [...fixture.map((w) => w.title)].sort((a, b) => a.localeCompare(b)));
});

test("the control's text and name for each sort and view", () => {
  assert.deepEqual(controlLabel("recent", "grid"), { text: "Recent · Grid", name: "Sort and view: recent, grid" });
  assert.deepEqual(controlLabel("recent", "list"), { text: "Recent · List", name: "Sort and view: recent, list" });
  assert.deepEqual(controlLabel("title", "grid"), { text: "Title · Grid", name: "Sort and view: title, grid" });
  assert.deepEqual(controlLabel("author", "list"), { text: "Author · List", name: "Sort and view: author, list" });
  assert.deepEqual(controlLabel("progress", "grid"), { text: "Progress · Grid", name: "Sort and view: progress, grid" });
});

test("the Shelf group's list: All shelves, Want to read, Reading and Finished", () => {
  assert.deepEqual(shelfChoices().map((c) => [c.value, c.label]), [
    ["all", "All shelves"],
    ["want-to-read", "Want to read"],
    ["reading", "Reading"],
    ["finished", "Finished"],
  ]);
});

test("a shelf in use is a chip under the heading that names it and clears it; none for All", () => {
  assert.deepEqual(shelfChip("want-to-read"), { text: "Want to read", name: "Clear the shelf: Want to read" });
  assert.deepEqual(shelfChip("reading"), { text: "Reading", name: "Clear the shelf: Reading" });
  assert.deepEqual(shelfChip("finished"), { text: "Finished", name: "Clear the shelf: Finished" });
  assert.equal(shelfChip(NO_SHELF), null);
});

test("the shelf read back from the device; an earlier build's Hardcover shelf read once as the shelf it stood for", () => {
  for (const shelf of ["want-to-read", "reading", "finished"] as const) assert.equal(readShelf(shelf), shelf);
  assert.equal(readShelf("all"), NO_SHELF);
  assert.equal(readShelf("bogus"), NO_SHELF);
  assert.equal(readShelf(null), NO_SHELF);
  // No shelf stored yet: the Hardcover filter an earlier build kept.
  assert.equal(readShelf(null, JSON.stringify({ shelf: "1", list: "all" })), "want-to-read");
  assert.equal(readShelf(null, JSON.stringify({ shelf: "2", list: "8803" })), "reading");
  assert.equal(readShelf(null, JSON.stringify({ shelf: "3", list: "all" })), "finished");
  assert.equal(readShelf(null, JSON.stringify({ shelf: "4", list: "all" })), NO_SHELF);
  assert.equal(readShelf(null, JSON.stringify({ shelf: "all", list: "11" })), NO_SHELF);
  assert.equal(readShelf(null, "not json"), NO_SHELF);
  assert.equal(readShelf(null, "[1,2]"), NO_SHELF);
  // A shelf stored by this build wins over the earlier filter, All included.
  assert.equal(readShelf("all", JSON.stringify({ shelf: "1", list: "all" })), NO_SHELF);
  assert.equal(readShelf("finished", JSON.stringify({ shelf: "1", list: "all" })), "finished");
});

test("the list row's second line: the author and each place line, or the download's line alone", () => {
  assert.equal(listRowLine(nothing), "Octavia E. Butler · Not started");
  assert.equal(listRowLine(pdfOnly), `${pdfOnly.author} · Not started`);
  assert.equal(listRowLine(readingEbook), `${readingEbook.author} · 38% of the ebook`);
  assert.equal(listRowLine(listening), `${listening.author} · Chapter 2 · 8 min left`);
  assert.equal(listRowLine(finished), "Iain M. Banks · Finished");
  assert.equal(listRowLine(downloading), "Downloading to server · 43%");
  assert.equal(listRowLine({ ...nothing, author: "" }), "Not started");
});
