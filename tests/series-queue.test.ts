// The series queue on the Series page (#898): what the audio search found and chose for a book, the run of a series'
// searches, and the owner's Stop searching, Resume, Search now, Search again, Skip and Choose this one instead. The
// series is a recorded AudiobookDB answer (tests/audiobookdb-fixture.ts); every search runs against the fakes below.
import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-queue-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
delete process.env.APP_PASSWORD;

let externalRequests = 0;
const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
const control = createControl();
// Test Saga: two books out and one not out yet, all in English.
const SERIES_ID = "sr-test-saga";
control.series.set(SERIES_ID, {
  id: SERIES_ID,
  name: "Test Saga",
  people: [{ name: "Ada Author", role: { name: "Author" } }],
  books: [
    seriesMember("bk-201", "First volume", "Ada Author", "1", 1, { releaseDate: "2020-01-01" }),
    seriesMember("bk-202", "Second volume", "Ada Author", "2", 2, { releaseDate: "2021-01-01" }),
    seriesMember("bk-203", "Future volume", "Ada Author", "3", 3, { releaseDate: "2999-01-01" }),
  ],
});
control.openLibrarySeries.set("test saga", []);
// Anything that is not AudiobookDB or Open Library is a defect here.
const noLiveRequest: typeof fetch = async (input) => {
  externalRequests++;
  throw new Error(`Unexpected external request: ${String(input instanceof Request ? input.url : input)}`);
};
const fetchFixture = fixtureFetch(control, noLiveRequest);
let clockNow = Date.now();
const clock = { now: () => clockNow, sleep: async (ms: number) => void (clockNow += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fetchFixture, clock });
ol.configureOpenLibraryForTests({ fetch: fetchFixture, clock });

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const {
  tickSeriesAcquisition,
  setSeriesAcquisitionDeps,
  resetSeriesAcquisitionDeps,
} = await import("../server/series-acquisition.ts");
type SeriesAcquisitionDeps = import("../server/series-acquisition.ts").SeriesAcquisitionDeps;
const { getWorkMediaState } = await import("../server/work-media-state.ts");
const { magnetHash } = await import("../server/acquisitions.ts");
const catalogue = await import("../server/series-catalogue.ts");
const { recordPack } = await import("../server/acquisition-packs.ts");
const { resetPackSearches } = await import("../server/series-pack-step.ts");

// No background loop ticks on its own here; the tests call tickSeriesAcquisition themselves.
const app = await createApp({ background: { manual: true } });
const originalFetch = globalThis.fetch;
// A request that does not go through the catalogue clients is caught too.
globalThis.fetch = noLiveRequest;

const { setSeriesReleaseSearchDeps, resetSeriesReleaseSearchDeps } = await import("../server/series-release-search.ts");
const { seriesAcquisitionSource } = await import("../server/series-acquisition-activity.ts");
const { collectActivity } = await import("../server/activity.ts");

const HASH = { one: "1".repeat(40), french: "2".repeat(40), set: "3".repeat(40), other: "4".repeat(40), pack: "7".repeat(40) };
/**
 * AudioBookBay's answer for the book's queries: the English single book, a French one, a box set, another English one.
 * The box set names no range of books, so the pack step (ADR 0027) does not take it: these are the book's own search.
 */
const RESULTS = [
  { id: "first-en", title: "First volume", format: "M4B", narrator: "Reader", language: "English", url: "https://abb.test/abss/first-en/", size: "400 MB" },
  { id: "first-fr", title: "First volume (Premier tome)", format: "MP3", narrator: "Lecteur", language: "French", url: "https://abb.test/abss/first-fr/", size: "380 MB" },
  { id: "saga-set", title: "Test Saga Box Set", format: "MP3", narrator: "Reader", language: "English", url: "https://abb.test/abss/saga-set/" },
  { id: "first-en-2", title: "First volume Unabridged", format: "MP3", narrator: "Someone", language: "English", url: "https://abb.test/abss/first-en-2/" },
];
/** A pack of both books out (ADR 0027): its title names the series and their range. */
const PACK = { id: "saga-pack", title: "Test Saga Books 1-2", format: "M4B", narrator: "Reader", language: "English", url: "https://abb.test/abss/saga-pack/", size: "800 MB" };
const HASHES: Record<string, string> = { "first-en": HASH.one, "first-fr": HASH.french, "saga-set": HASH.set, "first-en-2": HASH.other, "saga-pack": HASH.pack };

let results = RESULTS;
let cached = new Set<string>();
/** While set, a search for this title waits until the test opens it: the queue is caught with one search running. */
let hold: { title: string; open: () => void; opened: Promise<void> } | null = null;
const searched: string[] = [];
let acquired: { magnet: string; workId?: string }[] = [];

function holdSearch(title: string) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  hold = { title, open, opened };
  return () => {
    hold = null;
    open();
  };
}

const fakeAcquire = (async (magnet: string, metadata?: { workId?: string; userId?: number; title?: string; pack?: Parameters<typeof recordPack>[1] }) => {
  acquired.push({ magnet, workId: metadata?.workId });
  const id = randomUUID();
  const row = {
    id, hash: magnetHash(magnet) ?? randomUUID(), magnet, backend: "local", remoteId: null, title: metadata?.title ?? "First volume",
    author: "Ada Author", cover: "", workId: metadata?.workId ?? null, language: null, narrator: null, status: "checking" as const,
    progress: 0, error: null, bookId: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  db.insert(schema.acquisitions).values(row).run();
  db.insert(schema.userAcquisitions).values({ userId: metadata?.userId ?? 1, acquisitionId: id }).onConflictDoNothing().run();
  // As the real acquire: a series pack's download serves its books.
  if (metadata?.pack) recordPack(id, metadata.pack);
  return row;
}) as unknown as NonNullable<SeriesAcquisitionDeps["acquire"]>;

beforeEach(() => {
  externalRequests = 0;
  results = RESULTS;
  cached = new Set();
  hold = null;
  searched.length = 0;
  acquired = [];
  resetSeriesAcquisitionDeps();
  resetSeriesReleaseSearchDeps();
  resetPackSearches();
  for (const table of ["acquisition_works", "acquisition_packs", "series_acquisition_jobs", "user_series_seen_works", "user_saved_series_works", "user_saved_series", "series_catalogue_works",
    "series_catalogue", "work_media_states", "user_acquisitions", "acquisitions"])
    sqlite.exec(`DELETE FROM ${table}`);
  setSeriesAcquisitionDeps({
    acquire: fakeAcquire,
    seriesAudioDeps: {
      abbSearch: async (query: string) => {
        searched.push(`audio:${query}`);
        if (hold && query.toLowerCase().includes(hold.title.toLowerCase())) await hold.opened;
        // Only the first volume's queries find these; the second volume finds nothing.
        return { results: /first|saga/i.test(query) ? results : [], page: 1, nextPage: null };
      },
      prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
      abbMagnetLink: async (id: string) => `magnet:?xt=urn:btih:${HASHES[id] ?? "5".repeat(40)}&dn=${id}`,
      prowlarrMagnetLink: async () => "",
      cachedHashes: async () => cached,
      log: () => {},
    },
    fetchEbooks: async (workId) => {
      searched.push(`ebook:${db.select().from(schema.works).where(eq(schema.works.id, workId)).get()?.title}`);
      return { downloaded: [{ id: "libgen-deadbeef", status: "held" as const }], skipped: null, failures: [] as string[] };
    },
    canAcquireMedia: () => true,
  });
  setSeriesReleaseSearchDeps({
    acquire: fakeAcquire as never,
    abbRelease: (async (slug: string) => ({ id: slug, title: slug, author: "Ada Author", language: "French", narrator: null, cover: "", url: "" })) as never,
    abbMagnet: async (slug: string) => `magnet:?xt=urn:btih:${HASHES[slug] ?? "6".repeat(40)}&dn=${slug}`,
    replacePreviousAcquisition: (async () => ({ removed: true })) as never,
  });
});

afterEach(async () => {
  hold?.open();
  hold = null;
  await tickSeriesAcquisition();
});

after(async () => {
  globalThis.fetch = originalFetch;
  resetSeriesAcquisitionDeps();
  resetSeriesReleaseSearchDeps();
  await app.close();
  sqlite.close();
});

async function saveSeries(bookIds: string[], options?: { searchAudio?: boolean; searchEbooks?: boolean }) {
  const result = await app.inject({ method: "POST", url: "/api/series", payload: { id: SERIES_ID, bookIds, ...options } });
  assert.equal(result.statusCode, 200, result.body);
}
type Work = { id: string; workId: string; acquisition: { audio: Record<string, unknown> | null; ebook: Record<string, unknown> | null } | null };
type Series = { works: Work[]; queue: Record<string, unknown> };
const view = async () => (await app.inject(`/api/series/${SERIES_ID}`)).json() as Series;
const bookOf = async (bookId: string) => (await view()).works.find((work) => work.id === bookId)!;
const detail = async (bookId: string) => {
  const response = await app.inject(`/api/series/${SERIES_ID}/works/${bookId}/acquisition`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};
const post = async (url: string, payload?: unknown) => {
  const response = await app.inject({ method: "POST", url: `/api/series/${SERIES_ID}${url}`, payload: payload as object | undefined });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};
/** Waits until the queue's search for a book has started (the held search was asked). */
async function untilSearching(bookId: string) {
  for (let tries = 0; tries < 200; tries++) {
    const work = await bookOf(bookId);
    if (work.acquisition?.audio?.status === "searching" || work.acquisition?.ebook?.status === "searching") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${bookId} never started its search`);
}

test("the queue keeps what the audio search found and the one it chose, with each source's facts and why", async () => {
  cached = new Set([HASH.one]);
  await saveSeries(["bk-201"], { searchAudio: true });
  await tickSeriesAcquisition();
  const search = await detail("bk-201");
  assert.equal(search.audio.status, "done");
  assert.equal(search.choice.by, "queue");
  // The English single book TorBox has wins over the French one, the other English one and the set.
  assert.equal(search.choice.chosen, HASH.one);
  assert.deepEqual(
    search.choice.candidates.map((candidate: { id: string }) => candidate.id).sort(),
    ["first-en", "first-en-2", "first-fr", "saga-set"],
  );
  const chosen = search.choice.candidates.find((candidate: { key: string }) => candidate.key === HASH.one);
  assert.equal(chosen.url, "https://abb.test/abss/first-en/");
  assert.equal(chosen.language, "English");
  assert.equal(chosen.size, "400 MB");
  assert.equal(chosen.cached, true);
  assert.deepEqual(chosen.reasons, ["one-book", "torbox"]);
  const set = search.choice.candidates.find((candidate: { id: string }) => candidate.id === "saga-set");
  assert.deepEqual(set.reasons, ["compilation"]);
  assert.equal(search.choice.candidates.find((candidate: { id: string }) => candidate.id === "first-fr").language, "French");
  // Its download was asked for that release.
  assert.equal(acquired.length, 1);
  assert.match(acquired[0].magnet, new RegExp(HASH.one));
  // The Series page's row reads how many were found and that one was chosen.
  const row = await bookOf("bk-201");
  assert.equal(row.acquisition?.audio?.found, 4);
  assert.equal(row.acquisition?.audio?.chosen, true);
});

test("found but none chosen (only a set), and nothing found, are told apart", async () => {
  results = [RESULTS[2]];
  await saveSeries(["bk-201", "bk-202"], { searchAudio: true });
  await tickSeriesAcquisition();
  const first = await bookOf("bk-201");
  assert.equal(first.acquisition?.audio?.status, "done");
  assert.equal(first.acquisition?.audio?.found, 1);
  assert.equal(first.acquisition?.audio?.chosen, false);
  assert.equal((await detail("bk-201")).choice.chosen, null);
  // The second volume's search found nothing: an empty list kept, and the hold says so.
  const second = await bookOf("bk-202");
  assert.equal(second.acquisition?.audio?.found, 0);
  assert.equal(getWorkMediaState(1, second.workId)?.holdReason, "empty_search");
  assert.equal(acquired.length, 0);
});

test("the run line's facts: the search running now, how many wait, and their places in line", async () => {
  const open = holdSearch("First volume");
  await saveSeries(["bk-201", "bk-202"], { searchAudio: true, searchEbooks: true });
  await untilSearching("bk-201");
  const series = await view();
  assert.deepEqual(series.queue.searching, { bookId: "bk-201", kind: "audio" });
  assert.equal(series.queue.waiting, 3);
  assert.equal(series.queue.otherSearching, false);
  assert.equal(series.queue.paused, false);
  // While a search runs, the next one's time is not known.
  assert.equal(series.queue.nextAt, null);
  const places = series.works.flatMap((work) => [work.acquisition?.audio, work.acquisition?.ebook].map((state) => state?.place ?? null));
  // bk-201's ebook is 2nd, bk-202's audio 3rd and its ebook 4th, behind the search running now.
  assert.deepEqual(places.filter((place) => place !== null).sort(), [2, 3, 4]);
  assert.equal((await bookOf("bk-201")).acquisition?.ebook?.place, 2);
  open();
  await tickSeriesAcquisition();
  const done = await view();
  assert.equal(done.queue.searching, null);
  assert.equal(done.queue.waiting, 0);
});

test("Search now moves a book's searches to the front of the queue", async () => {
  const open = holdSearch("First volume");
  await saveSeries(["bk-201", "bk-202"], { searchAudio: true, searchEbooks: true });
  await untilSearching("bk-201");
  const moved = await post("/works/bk-202/acquisition/now", { kind: "audio" });
  assert.equal(moved.moved, 1);
  assert.equal((await bookOf("bk-202")).acquisition?.audio?.place, 2);
  assert.equal((await bookOf("bk-201")).acquisition?.ebook?.place, 3);
  open();
  await tickSeriesAcquisition();
  // After the search that was running, the queue ran bk-202's audio search before bk-201's ebook.
  const order = searched.filter((entry) => entry === "ebook:First volume" || /^audio:.*second/i.test(entry));
  assert.ok(order.length >= 2, searched.join(", "));
  assert.match(order[0], /^audio:/i);
});

test("Stop searching stops the series' waiting searches and not the running one; Resume puts them back", async () => {
  const open = holdSearch("First volume");
  await saveSeries(["bk-201", "bk-202"], { searchAudio: true });
  await untilSearching("bk-201");
  const stopped = await post("/queue/stop", {});
  assert.equal(stopped.stopped, 1);
  assert.equal(stopped.queue.waiting, 0);
  assert.equal(stopped.queue.stopped, 1);
  const waiting = await bookOf("bk-202");
  assert.deepEqual([waiting.acquisition?.audio?.status, waiting.acquisition?.audio?.skipReason], ["skipped", "stopped"]);
  open();
  await tickSeriesAcquisition();
  // The search that was running finished and chose its release; the stopped one never ran.
  assert.equal((await bookOf("bk-201")).acquisition?.audio?.status, "done");
  assert.ok(!searched.some((entry) => /second/i.test(entry)), searched.join(", "));
  // Activity names it as the owner's, opening the Series page at the book.
  const deps = { sqlite, getSetting: () => undefined, pauseState: () => ({}), now: () => Date.now() } as never;
  const activity = await collectActivity(deps, { probes: false }, [seriesAcquisitionSource]);
  const item = activity.items.find((entry) => entry.facts.kind === "series-acquisition" && entry.facts.seriesBookId === "bk-202")!;
  assert.equal(item.state, "done");
  assert.deepEqual([item.facts.kind === "series-acquisition" && item.facts.outcome, item.facts.kind === "series-acquisition" && item.facts.seriesId], ["stopped", SERIES_ID]);

  const resumed = await post("/queue/resume");
  assert.equal(resumed.resumed, 1);
  await tickSeriesAcquisition();
  assert.equal((await bookOf("bk-202")).acquisition?.audio?.status, "done");
});

test("Skip: a waiting search never runs, a running one downloads nothing; Search now undoes a skip", async () => {
  const open = holdSearch("First volume");
  await saveSeries(["bk-201", "bk-202"], { searchAudio: true });
  await untilSearching("bk-201");
  // An empty body, as an older client may send: both kinds of the book.
  const skippedWaiting = await post("/works/bk-202/acquisition/skip");
  assert.equal(skippedWaiting.skipped, 1);
  assert.deepEqual([skippedWaiting.audio.status, skippedWaiting.audio.skipReason], ["skipped", "owner"]);
  const skippedRunning = await post("/works/bk-201/acquisition/skip", { kind: "audio" });
  assert.equal(skippedRunning.audio.skipReason, "owner");
  open();
  await tickSeriesAcquisition();
  assert.equal(acquired.length, 0, "the skipped search that was running downloaded nothing");
  assert.ok(!searched.some((entry) => /second/i.test(entry)));
  // Its finds are kept all the same, for the owner to choose from.
  assert.equal((await detail("bk-201")).choice.candidates.length, 4);
  assert.equal((await bookOf("bk-201")).acquisition?.audio?.status, "skipped");

  await post("/works/bk-202/acquisition/now", {});
  await tickSeriesAcquisition();
  assert.equal((await bookOf("bk-202")).acquisition?.audio?.status, "done");
});

test("Choose this one instead downloads another found release through the manual select, chosen by the owner", async () => {
  cached = new Set([HASH.other]);
  await saveSeries(["bk-201"], { searchAudio: true });
  await tickSeriesAcquisition();
  // The queue chose the other English release, the one TorBox has (a French one is never picked: #897's rule).
  assert.equal((await detail("bk-201")).choice.chosen, HASH.other);
  const chosen = await post("/works/bk-201/acquisition/choose", { key: HASH.one });
  assert.equal(chosen.search.choice.chosen, HASH.one);
  assert.equal(chosen.search.choice.by, "owner");
  assert.match(acquired.at(-1)!.magnet, new RegExp(HASH.one));
  assert.equal(chosen.search.audio.status, "done");
  // Older clients name it by its source and id.
  const again = await post("/works/bk-201/acquisition/choose", { source: "abb", id: "first-fr" });
  assert.equal(again.search.choice.chosen, HASH.french);
  // A release the search did not find is refused.
  const refused = await app.inject({ method: "POST", url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/choose`, payload: { key: "nothing" } });
  assert.equal(refused.statusCode, 404);
});

test("a pack the queue takes for two waiting books is the chosen release of each, with what the pack search found", async () => {
  results = [...RESULTS, PACK];
  await saveSeries(["bk-201", "bk-202"], { searchAudio: true });
  await tickSeriesAcquisition();
  // One download for both books (ADR 0027), and no search of their own.
  assert.equal(acquired.length, 1);
  assert.match(acquired[0].magnet, new RegExp(HASH.pack));
  for (const bookId of ["bk-201", "bk-202"]) {
    const search = await detail(bookId);
    assert.equal(search.audio.status, "done", bookId);
    assert.deepEqual([search.choice.chosen, search.choice.by], [HASH.pack, "queue"], bookId);
    // The packs the search found, with their source's facts: the box set names no range and is none.
    assert.deepEqual(search.choice.candidates.map((candidate: { id: string }) => candidate.id), ["saga-pack"], bookId);
    const chosen = search.choice.candidates[0];
    assert.deepEqual([chosen.url, chosen.language, chosen.kind], [PACK.url, "English", "compilation"], bookId);
    const row = await bookOf(bookId);
    assert.deepEqual([row.acquisition?.audio?.found, row.acquisition?.audio?.chosen], [1, true], bookId);
  }
});

test("Search again for a book with its audiobook on its way finds the releases again and downloads nothing", async () => {
  await saveSeries(["bk-201"], { searchAudio: true });
  await tickSeriesAcquisition();
  assert.equal(acquired.length, 1);
  const before = (await detail("bk-201")).choice;
  results = [RESULTS[0], RESULTS[1]];
  const asked = await post("/works/bk-201/acquisition/again", { kind: "audio" });
  // At the front of the queue: it may have started already.
  assert.ok(["pending", "searching"].includes(asked.audio.status), asked.audio.status);
  await tickSeriesAcquisition();
  const after = await detail("bk-201");
  assert.equal(acquired.length, 1, "no second download");
  assert.equal(after.audio.status, "done");
  assert.equal(after.choice.candidates.length, 2);
  // The release on its way stays the chosen one.
  assert.equal(after.choice.chosen, before.chosen);
  assert.ok(after.choice.at >= before.at);
});

test("a search run again that finds nothing replaces what an earlier one found", async () => {
  results = [RESULTS[2]];
  await saveSeries(["bk-201"], { searchAudio: true });
  await tickSeriesAcquisition();
  assert.equal((await bookOf("bk-201")).acquisition?.audio?.found, 1);
  results = [];
  await post("/works/bk-201/acquisition/again", { kind: "audio" });
  await tickSeriesAcquisition();
  assert.equal((await bookOf("bk-201")).acquisition?.audio?.found, 0);
  assert.deepEqual((await detail("bk-201")).choice.candidates, []);
});

test("the owner's choice stays the owner's after Search again", async () => {
  await saveSeries(["bk-201"], { searchAudio: true });
  await tickSeriesAcquisition();
  await post("/works/bk-201/acquisition/choose", { key: HASH.french });
  await post("/works/bk-201/acquisition/again", { kind: "audio" });
  await tickSeriesAcquisition();
  const choice = (await detail("bk-201")).choice;
  assert.deepEqual([choice.chosen, choice.by], [HASH.french, "owner"]);
});

test("a skip holds when the series asks for the book again by itself; Search now undoes it", async () => {
  await saveSeries(["bk-201"], { searchAudio: true, searchEbooks: true });
  await tickSeriesAcquisition();
  await post("/works/bk-201/acquisition/skip", { kind: "ebook" });
  const { enqueueSeriesAcquisition } = await import("../server/series-acquisition.ts");
  const workId = (await bookOf("bk-201")).workId;
  enqueueSeriesAcquisition(1, SERIES_ID, [{ bookId: "bk-201", workId, unreleased: false }], { searchEbooks: true });
  await tickSeriesAcquisition();
  assert.equal((await bookOf("bk-201")).acquisition?.ebook?.skipReason, "owner");
});

test("an ebook search that runs now cannot be skipped: it downloads as it searches", async () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  setSeriesAcquisitionDeps({
    fetchEbooks: async () => {
      await opened;
      return { downloaded: [], skipped: null, failures: [] as string[] };
    },
  });
  await saveSeries(["bk-201"], { searchEbooks: true });
  for (let tries = 0; tries < 200 && (await bookOf("bk-201")).acquisition?.ebook?.status !== "searching"; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const refused = await app.inject({ method: "POST", url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/skip`, payload: { kind: "ebook" } });
  assert.equal(refused.statusCode, 409);
  open();
});
