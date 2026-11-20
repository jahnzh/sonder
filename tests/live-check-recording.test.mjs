import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// A namespace import, so a test of a function the module does not have fails on its own.
import * as rec from "../scripts/live-check-recording.mjs";

const { BOOK_END_MARGIN_SECONDS, NO_SUITABLE_RECORDING_EXIT, NoSuitableRecording, TRACK_END_MARGIN_SECONDS, savedStart } = rec;

// Shapes copied from GET /api/books, /api/ebooks and /api/alignments of tests/browser-server.ts after the
// integrated-reader spec's seeding (import of server/demo/alice-01.mp3, EPUB import, alignment, POST /api/progress).
export function book(n, { tracks = [{ duration: 640.584 }], progress, inLibrary = true, workId } = {}) {
  const recordingId = `recording-${n}`;
  const built = tracks.map((t, index) => ({
    chapters: t.chapters ?? [],
    id: t.id ?? `track-${n}-${index}`,
    recordingId,
    title: `wonderland_ch_0${index + 1}`,
    index,
    duration: t.duration,
    source: "",
    sourceType: "local",
    serverAvailable: true,
    deliverySource: "server",
  }));
  return {
    serverStored: true,
    faults: {},
    id: n,
    workId: workId ?? `work-${n}`,
    editionId: n,
    recordingId,
    title: `Book ${n}`,
    author: "Reader QA",
    narrator: "Reader QA",
    language: null,
    releaseTitle: null,
    genre: "Audiobook",
    year: 2026,
    cover: "/covers/meditations.svg",
    rating: 0,
    sourceLabel: "Your audio files",
    tracks: built,
    duration: built.reduce((sum, t) => sum + t.duration, 0),
    inLibrary,
    status: "listening",
    addedAt: 1794748752172,
    ...(progress
      ? {
          progress: {
            userId: 1,
            recordingId,
            trackId: progress.trackId ?? built[progress.track ?? 0].id,
            position: progress.position,
            duration: built[progress.track ?? 0].duration,
            updatedAt: progress.updatedAt ?? 1794748752519,
          },
        }
      : {}),
    mediaState: null,
  };
}
function ebook(b, { format = "epub", available = true, id = `upload-${b.id}`, workId = b.workId } = {}) {
  return { id, workId, title: b.title, author: b.author, format, size: 2286, available };
}
const mapped = (trackId, start, end, paragraphId = `0:${start}`) => ({ paragraphId, section: 0, trackId, start, end, confidence: 0.65 });
// Contiguous sentences of `length` seconds from `from` to `to` on one file, as a dense map has them.
const sentences = (trackId, from, to, length = 6) => Array.from({ length: Math.floor((to - from) / length) }, (_, i) => mapped(trackId, from + i * length, from + (i + 1) * length));
function job(b, { ebookId = `upload-${b.id}`, status = "partial", progress = 1, origin, updatedAt = 1794748752503, intervals, id } = {}) {
  return {
    id: id ?? `job-${b.id}-${ebookId}`,
    ebookId,
    recordingId: b.recordingId,
    status,
    progress,
    engine: "ctc",
    error: null,
    warning: null,
    intervals: intervals ?? [mapped(b.tracks[0].id, 0, 2), mapped(b.tracks[0].id, 10, 20), mapped(b.tracks[0].id, 30, 40)],
    sectionsDone: [0],
    updatedAt,
    createdAt: updatedAt - 1000,
    outcome: "mapped",
    ...(origin ? { origin } : {}),
  };
}
// GET /api/library lists each book's work with the same editions as GET /api/ebooks (in that order), and no shared
// default, unless an entry gives its own `work`.
const listingOf = (entries) => {
  const ebooks = entries.flatMap((e) => e.ebooks ?? [ebook(e.book)]);
  const works = new Map();
  for (const e of entries)
    if (!works.has(e.book.workId))
      works.set(e.book.workId, e.work ?? work(e.book, { ebooks: ebooks.filter((x) => x.workId === e.book.workId).map((x) => edition(x.id, { format: x.format, available: x.available, size: x.size })) }));
  return {
    books: entries.map((e) => e.book),
    ebooks,
    jobs: entries.flatMap((e) => e.jobs ?? [job(e.book)]),
    works: [...works.values()],
  };
};

// A fake server for the selection functions: `answers[path]` is a body (200, JSON), {status, body|text}, or a function.
// Paths not given answer as the listing says; every request is recorded.
function server(listing, answers = {}) {
  const requests = [];
  const get = async (path) => {
    requests.push(path);
    let answer = answers[path];
    if (typeof answer === "function") answer = await answer();
    if (answer === undefined) {
      if (path === "/api/books") answer = listing.books;
      else if (path === "/api/ebooks") answer = listing.ebooks;
      else if (path === "/api/alignments") answer = { available: true, localOnly: true, jobs: listing.jobs };
      else if (path === "/api/library") answer = listing.works ?? [];
      else if (path === "/api/appearance") answer = {};
      else {
        const id = /^\/api\/alignments\/([^/]+)\/map$/.exec(path)?.[1];
        const found = id && listing.jobs.find((j) => j.id === decodeURIComponent(id));
        answer = found ?? { status: 400, body: { error: "This reading-sync job could not be found." } };
      }
    }
    if (answer && typeof answer === "object" && "status" in answer && ("body" in answer || "text" in answer))
      return { status: answer.status, text: answer.text ?? JSON.stringify(answer.body) };
    return { status: 200, text: JSON.stringify(answer) };
  };
  return { get, requests };
}
const mapPath = (j) => `/api/alignments/${encodeURIComponent(j.id)}/map`;
const select = (listing, options, answers) => rec.selectReaderRecording(server(listing, answers).get, options);

test("the incident: the only aligned recording was finished (last second of the last track), so none qualifies", async () => {
  const finished = book("torbox-137435781", { tracks: [{ duration: 3600 }, { duration: 2400 }], progress: { track: 1, position: 2399 } });
  const listing = listingOf([{ book: finished, jobs: [job(finished, { status: "ready", intervals: [mapped(finished.tracks[1].id, 10, 20)] })] }]);
  const { get, requests } = server(listing);
  await assert.rejects(rec.selectReaderRecording(get, { preferred: finished.recordingId }), (error) => {
    assert.ok(error instanceof NoSuitableRecording);
    assert.equal(error.reason, "1 aligned recording(s) in the library, none qualifies: recording-torbox-137435781: the saved position is 1 s before the end of the book (needs more than 300 s)");
    return true;
  });
  assert.deepEqual(requests, ["/api/books", "/api/ebooks", "/api/alignments", "/api/library"], "no map is fetched for a recording that cannot qualify");
});

test("a mapped recording at a saved position in the middle of its book is picked with its EPUB, map and sequence", async () => {
  const b = book("a", { progress: { position: 42 } });
  const listing = listingOf([{ book: b }]);
  const pick = await select(listing);
  assert.equal(pick.recordingId, b.recordingId);
  assert.deepEqual(pick.book, b);
  assert.equal(pick.ebook.id, "upload-a");
  assert.equal(pick.job.id, "job-a-upload-a");
  assert.deepEqual(pick.map, listing.jobs[0]);
  assert.deepEqual(pick.sequence.start, { trackId: b.tracks[0].id, position: 42 });
  assert.equal(pick.preferred, undefined);
});

test("the named recording is preferred when it qualifies, over a newer ready map", async () => {
  const named = book("named", { progress: { position: 42 } });
  const other = book("other", { progress: { position: 42 } });
  const listing = listingOf([
    { book: named, jobs: [job(named, { status: "partial", updatedAt: 100 })] },
    { book: other, jobs: [job(other, { status: "ready", updatedAt: 900 })] },
  ]);
  assert.equal((await select(listing, { preferred: named.recordingId })).recordingId, named.recordingId);
  assert.equal((await select(listing)).recordingId, other.recordingId);
});

test("a named recording that does not qualify gives way to another, and the reason is kept", async () => {
  const named = book("named", { progress: { position: 639 } });
  const other = book("other", { progress: { position: 42 } });
  const pick = await select(listingOf([{ book: named }, { book: other }]), { preferred: named.recordingId });
  assert.equal(pick.recordingId, other.recordingId);
  assert.deepEqual(pick.preferred, { recordingId: named.recordingId, reason: "the saved position is 2 s before the end of the book (needs more than 300 s)" });
  const missing = await select(listingOf([{ book: other }]), { preferred: "recording-gone" });
  assert.equal(missing.recordingId, other.recordingId);
  assert.deepEqual(missing.preferred, { recordingId: "recording-gone", reason: "the recording is not in the book listing" });
});

test("without a preference: a ready map before a partial one, then the most recently updated (deploy.sh's old order)", async () => {
  const books = ["old-ready", "new-ready", "newest-partial"].map((n) => book(n, { progress: { position: 42 } }));
  const listing = listingOf([
    { book: books[0], jobs: [job(books[0], { status: "ready", updatedAt: 100 })] },
    { book: books[1], jobs: [job(books[1], { status: "ready", updatedAt: 200 })] },
    { book: books[2], jobs: [job(books[2], { status: "partial", updatedAt: 300 })] },
  ]);
  assert.deepEqual(rec.readerPairs(listing).pairs.map((p) => p.book.recordingId), ["recording-new-ready", "recording-old-ready", "recording-newest-partial"]);
  assert.equal((await select(listing)).recordingId, "recording-new-ready");
});

test("only a finished, non-projected EPUB map with intervals of the same work, for a library book, counts as aligned", async () => {
  const cases = {
    unfinished: (b) => ({ jobs: [job(b, { progress: 0.5 })] }),
    empty: (b) => ({ jobs: [job(b, { intervals: [] })] }),
    projected: (b) => ({ jobs: [job(b, { status: "ready", origin: "projected" })] }),
    pdf: (b) => ({ ebooks: [ebook(b, { format: "pdf" })] }),
    unavailable: (b) => ({ ebooks: [ebook(b, { available: false })] }),
    otherWork: (b) => ({ ebooks: [ebook(b, { workId: "work-elsewhere" })] }),
  };
  for (const [name, variant] of Object.entries(cases)) {
    const b = book(name, { progress: { position: 42 } });
    await assert.rejects(select(listingOf([{ book: b, ...variant(b) }])), { reason: "no aligned recording(s) in the library" }, name);
  }
  const outside = book("outside", { progress: { position: 42 }, inLibrary: false });
  await assert.rejects(select(listingOf([{ book: outside }])), NoSuitableRecording);
  // A projected map does not hide the real map of the same recording.
  const both = book("both", { progress: { position: 42 } });
  const pick = await select(listingOf([{ book: both, jobs: [job(both, { origin: "projected", status: "ready", id: "projected" }), job(both, { status: "partial" })] }]));
  assert.equal(pick.job.id, "job-both-upload-both");
});

test("the end-of-book margin: more than 300 s left qualifies, 300 s does not", () => {
  const at = (position) => rec.readerPairs(listingOf([{ book: book("edge", { tracks: [{ duration: 1000 }], progress: { position } }), jobs: [job(book("edge"), { intervals: sentences("track-edge-0", 0, 1000) })] }]));
  assert.equal(BOOK_END_MARGIN_SECONDS, 300);
  assert.equal(at(1000 - 300).pairs.length, 0);
  assert.match(at(1000 - 300).rejected[0].reason, /300 s before the end of the book/);
  assert.equal(at(1000 - 301).pairs.length, 1);
});

test("the end-of-book margin counts the whole book across tracks, not the current file", () => {
  // 200 s left in the first file but 1200 s left in the book: the book rule passes, the file rule decides.
  const tracks = [{ duration: 1000 }, { duration: 1000 }];
  const early = book("multi", { tracks, progress: { track: 0, position: 800 } });
  assert.deepEqual(savedStart(early), { track: early.tracks[0], position: 800, bookPosition: 800, bookDuration: 2000 });
  const late = book("multi-late", { tracks, progress: { track: 1, position: 800 } });
  assert.equal(savedStart(late).bookPosition, 1800);
  const listing = listingOf([{ book: late, jobs: [job(late, { intervals: [mapped(late.tracks[1].id, 10, 20)] })] }]);
  assert.match(rec.readerPairs(listing).rejected[0].reason, /the saved position is 200 s before the end of the book/);
});

test("the end-of-file margin: the start must be more than 60 s before the end of its file", () => {
  const tracks = [{ duration: 1000 }, { duration: 1000 }];
  const at = (position) => {
    const b = book("file-edge", { tracks, progress: { track: 0, position } });
    return rec.readerPairs(listingOf([{ book: b, jobs: [job(b, { intervals: sentences(b.tracks[0].id, 0, 1000) })] }]));
  };
  assert.equal(TRACK_END_MARGIN_SECONDS, 60);
  assert.match(at(940).rejected[0].reason, /the saved position is 60 s before the end of its file \(needs more than 60 s\)/);
  assert.equal(at(939).pairs.length, 1);
});

test("a saved position on a file with no mapped passage longer than 4 s does not qualify (an unmapped intro before the first mapped interval)", () => {
  const tracks = [{ duration: 600 }, { duration: 3000 }];
  const intro = book("intro", { tracks, progress: { track: 0, position: 30 } });
  const intervals = [mapped(intro.tracks[0].id, 500, 503), mapped(intro.tracks[1].id, 10, 20)];
  const result = rec.readerPairs(listingOf([{ book: intro, jobs: [job(intro, { intervals })] }]));
  assert.equal(result.pairs.length, 0);
  assert.match(result.rejected[0].reason, /the saved position is on file track-intro-0, which has no mapped passage longer than 4 s/);
  const into = book("into", { tracks, progress: { track: 1, position: 5 } });
  const ok = rec.readerSequence([mapped(into.tracks[0].id, 500, 503), ...sentences(into.tracks[1].id, 10, 400)], into);
  assert.deepEqual(ok.start, { trackId: "track-into-1", position: 5 });
});

test("without saved progress playback starts on the first file at 0", () => {
  const fresh = book("fresh");
  assert.deepEqual(savedStart(fresh), { track: fresh.tracks[0], position: 0, bookPosition: 0, bookDuration: 640.584 });
  assert.deepEqual(rec.readerSequence(job(fresh).intervals, fresh).start, { trackId: fresh.tracks[0].id, position: 0 });
});

test("a saved position on a track the recording does not have does not qualify", () => {
  const stale = book("stale", { progress: { trackId: "track-gone", position: 42 } });
  assert.match(rec.readerPairs(listingOf([{ book: stale }])).rejected[0].reason, /names track track-gone, which the recording does not have/);
});

// Review round 1, BLOCKING: a broken endpoint must not become a skip.
test("a map that answers 5xx, 401 or 403 fails the check naming the request, it is not 'no suitable recording'", async () => {
  const b = book("broken", { progress: { position: 42 } });
  const listing = listingOf([{ book: b }]);
  for (const status of [500, 502, 503, 401, 403, 400]) {
    await assert.rejects(select(listing, {}, { [mapPath(listing.jobs[0])]: { status, body: { error: "boom" } } }), (error) => {
      assert.ok(!(error instanceof NoSuitableRecording), `HTTP ${status} must not be a skip`);
      assert.equal(error.message, `GET /api/alignments/job-broken-upload-broken/map answered ${status}`);
      return true;
    });
  }
});

test("a map body that is not JSON, or a map of another recording, fails the check", async () => {
  const b = book("garbled", { progress: { position: 42 } });
  const listing = listingOf([{ book: b }]);
  const path = mapPath(listing.jobs[0]);
  await assert.rejects(select(listing, {}, { [path]: { status: 200, text: "<html>proxy error</html>" } }), (error) => !(error instanceof NoSuitableRecording) && /map answered 200 with a body that is not JSON/.test(error.message));
  await assert.rejects(select(listing, {}, { [path]: { ...listing.jobs[0], recordingId: "recording-else" } }), (error) => !(error instanceof NoSuitableRecording) && /map answered with an unexpected shape/.test(error.message));
  await assert.rejects(select(listing, {}, { [path]: { id: "x" } }), (error) => !(error instanceof NoSuitableRecording) && /unexpected shape/.test(error.message));
});

test("a map request that throws (a timeout) fails the check with the request named", async () => {
  const b = book("slow", { progress: { position: 42 } });
  const listing = listingOf([{ book: b }]);
  const context = { request: { get: async (path) => { if (path.endsWith("/map")) throw new Error("apiRequestContext.get: Timeout 30000ms exceeded."); return { status: () => 200, text: async () => JSON.stringify(path === "/api/books" ? listing.books : path === "/api/ebooks" ? listing.ebooks : path === "/api/library" ? listing.works : { jobs: listing.jobs }) }; } } };
  await assert.rejects(rec.selectReaderRecording(rec.requestFrom(context)), (error) => !(error instanceof NoSuitableRecording) && error.message === "GET /api/alignments/job-slow-upload-slow/map failed: apiRequestContext.get: Timeout 30000ms exceeded.");
});

test("a listing that fails, cannot be parsed or has another shape fails the check; only a listing read successfully can be 'none qualifies'", async () => {
  const b = book("ok", { progress: { position: 42 } });
  const listing = listingOf([{ book: b }]);
  const failures = {
    "/api/books": [{ status: 500, body: {} }, { status: 401, body: { error: "Sign in" } }, { status: 200, text: "not json" }, { books: [] }, [{ id: "no recording" }]],
    "/api/ebooks": [{ status: 503, body: {} }, { status: 200, text: "" }, { ebooks: [] }],
    "/api/alignments": [{ status: 403, body: {} }, { status: 200, text: "{" }, [], { jobs: "none" }],
  };
  for (const [path, answers] of Object.entries(failures)) {
    for (const answer of answers) {
      await assert.rejects(select(listing, {}, { [path]: answer }), (error) => {
        assert.ok(!(error instanceof NoSuitableRecording), `${path} ${JSON.stringify(answer)} must not be a skip`);
        assert.ok(error.message.startsWith(`GET ${path} answered`), error.message);
        return true;
      });
    }
  }
  // A failing status fails by its status even when the body looks like a listing (a proxy's cached answer).
  for (const [path, body] of [["/api/books", listing.books], ["/api/ebooks", listing.ebooks], ["/api/alignments", { jobs: listing.jobs }]])
    await assert.rejects(select(listing, {}, { [path]: { status: 503, body } }), { message: `GET ${path} answered 503` }, path);
  await assert.rejects(select({ books: [], ebooks: [], jobs: [] }), { reason: "no aligned recording(s) in the library" });
});

test("a map answer of 410 (stale) or 404 excludes that map and the next one is tried; with none left the check is skipped", async () => {
  const first = book("first", { progress: { position: 42 } });
  const second = book("second", { progress: { position: 42 } });
  const listing = listingOf([
    { book: first, jobs: [job(first, { status: "ready" })] },
    { book: second, jobs: [job(second, { status: "partial" })] },
  ]);
  const stale = { status: 410, body: { code: "alignment_stale", error: "The ebook or audio changed. Rebuild this alignment before using it." } };
  const next = await select(listing, {}, { [mapPath(listing.jobs[0])]: stale });
  assert.equal(next.recordingId, second.recordingId);
  await assert.rejects(select(listing, {}, { [mapPath(listing.jobs[0])]: stale, [mapPath(listing.jobs[1])]: { status: 404, body: {} } }), (error) => {
    assert.ok(error instanceof NoSuitableRecording);
    assert.equal(error.reason, "2 aligned recording(s) in the library, none qualifies: recording-first (map job-first-upload-first): its map answered HTTP 410 (alignment_stale); recording-second (map job-second-upload-second): its map answered HTTP 404");
    return true;
  });
});

// Review round 1, HIGH: candidates are (recording, map) pairs.
test("a stale map excludes that map only: another map of the same recording is tried next", async () => {
  const b = book("two-epubs", { progress: { position: 42 } });
  const epubA = ebook(b, { id: "epub-a" }), epubB = ebook(b, { id: "epub-b" });
  const jobA = job(b, { ebookId: "epub-a", status: "ready", updatedAt: 900 });
  const jobB = job(b, { ebookId: "epub-b", status: "partial", updatedAt: 100 });
  const listing = listingOf([{ book: b, ebooks: [epubA, epubB], jobs: [jobA, jobB] }]);
  const { get, requests } = server(listing, { [mapPath(jobA)]: { status: 410, body: { code: "alignment_stale" } } });
  const pick = await rec.selectReaderRecording(get);
  assert.equal(pick.recordingId, b.recordingId);
  assert.equal(pick.job.id, jobB.id);
  assert.equal(pick.ebook.id, "epub-b");
  assert.deepEqual(requests.slice(4), [mapPath(jobA), mapPath(jobB)]);
});

test("a map with no usable passage on the loaded file excludes that map, and another map of the same recording is used", async () => {
  const b = book("two-maps", { tracks: [{ duration: 1000 }], progress: { position: 42 } });
  const epubA = ebook(b, { id: "epub-a" }), epubB = ebook(b, { id: "epub-b" });
  // The listing says map A is fine, but the map it serves now has only short intervals.
  const jobA = job(b, { ebookId: "epub-a", status: "ready", intervals: sentences(b.tracks[0].id, 0, 600) });
  const jobB = job(b, { ebookId: "epub-b", status: "partial", intervals: sentences(b.tracks[0].id, 0, 600) });
  const listing = listingOf([{ book: b, ebooks: [epubA, epubB], jobs: [jobA, jobB] }]);
  const pick = await select(listing, {}, { [mapPath(jobA)]: { ...jobA, intervals: [mapped(b.tracks[0].id, 10, 12)] } });
  assert.equal(pick.job.id, jobB.id);
  const pairs = rec.readerPairs(listing).pairs;
  assert.deepEqual(pairs.map((p) => p.job.id), [jobA.id, jobB.id], "one candidate per map of the recording");
});

// Review round 1, HIGH: selection asks what the check will do.
test("the reviewer's sparse map (one interval at 200-206 s on a 1000 s file, saved position 0) does not qualify", async () => {
  const b = book("sparse", { tracks: [{ duration: 1000 }] });
  const sparse = job(b, { status: "ready", intervals: [mapped(b.tracks[0].id, 200, 206)] });
  const result = rec.readerSequence(sparse.intervals, b);
  assert.match(result.reason, /no highlighted passage is followed within 10 s by another/);
  await assert.rejects(select(listingOf([{ book: b, jobs: [sparse] }])), NoSuitableRecording);
  // Mapped passages far apart cannot show the narration advance either.
  const apart = [mapped(b.tracks[0].id, 100, 110), mapped(b.tracks[0].id, 500, 510), mapped(b.tracks[0].id, 900, 910)];
  assert.match(rec.readerSequence(apart, b).reason, /cannot be seen to advance/);
  // Contiguous intervals of one passage keep the same highlight, so they cannot show the narration advance.
  const onePassage = sentences(b.tracks[0].id, 100, 400).map((i) => ({ ...i, paragraphId: "0:only" }));
  assert.match(rec.readerSequence(onePassage, b).reason, /cannot be seen to advance/);
});

test("the reader sequence: every seek target shows the sampled passage, and Play starts on a passage another follows within 10 s", () => {
  const b = book("dense", { tracks: [{ duration: 1000 }], progress: { position: 42 } });
  const intervals = sentences(b.tracks[0].id, 100, 700);
  const sequence = rec.readerSequence(intervals, b);
  assert.equal(sequence.trackId, b.tracks[0].id);
  for (const sample of sequence.samples) {
    assert.equal(rec.passageAt(intervals, sequence.trackId, sample.position).paragraphId, sample.paragraphId);
    assert.equal(rec.passageAt(intervals, sequence.trackId, sample.middle).paragraphId, sample.paragraphId);
  }
  const { follow, middle } = sequence;
  assert.equal(rec.passageAt(intervals, sequence.trackId, follow.start).paragraphId, follow.passage);
  assert.notEqual(follow.next, follow.passage);
  assert.ok(follow.nextAt > follow.start && follow.nextAt - follow.start <= rec.FOLLOW_ADVANCE_SECONDS, JSON.stringify(follow));
  assert.equal(rec.passageAt(intervals, sequence.trackId, follow.nextAt).paragraphId, follow.next);
  // The old target (20 s before the middle sample) is kept when it works: it is inside a passage, and the next begins 5 s later.
  assert.equal(follow.start, middle.position - rec.FOLLOW_WAIT_SECONDS);
  // A passage the reader would not highlight at the seek target (an earlier interval holds that time) does not qualify.
  // Reader.tsx takes the first interval holding the time: here a short one listed earlier covers the first sample's seek target.
  const overlapped = [mapped(b.tracks[0].id, 104.5, 106.5, "short"), mapped(b.tracks[0].id, 100, 107, "long"), ...sentences(b.tracks[0].id, 110, 400)];
  assert.match(rec.readerSequence(overlapped, b).reason, /at 106 s on file track-dense-0 the reader highlights passage short, not the sampled passage long/);
});

test("the reader sequence plays more than 60 s before the end of the file, so playback cannot run into the end of the book", () => {
  // Saved position early on the last (only) file; the only mapped passages are in its last minute.
  const b = book("late-map", { tracks: [{ duration: 1000 }], progress: { position: 10 } });
  assert.match(rec.readerSequence(sentences(b.tracks[0].id, 942, 1000), b).reason, /not more than 60 s before the end of file/);
  const nearEnd = [...sentences(b.tracks[0].id, 100, 130), ...sentences(b.tracks[0].id, 900, 1000)];
  const sequence = rec.readerSequence(nearEnd, b);
  assert.equal(sequence.reason, undefined);
  assert.ok(sequence.middle.middle < 1000 - TRACK_END_MARGIN_SECONDS);
  assert.ok(sequence.follow.start + rec.FOLLOW_WAIT_SECONDS < 1000 - TRACK_END_MARGIN_SECONDS, JSON.stringify(sequence.follow));
  // Passages that could show the advance only in the last minute do not count: here the early ones stand alone.
  const lonely = [mapped(b.tracks[0].id, 100, 110), mapped(b.tracks[0].id, 300, 310), mapped(b.tracks[0].id, 500, 510), ...sentences(b.tracks[0].id, 925, 940)];
  assert.match(rec.readerSequence(lonely, b).reason, /cannot be seen to advance/);
});

test("the check seeks and plays where the sequence says (static check of verify-integrated-reader.mjs)", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify-integrated-reader.mjs"), "utf8");
  assert.match(source, /selectReaderRecording\(get,\{preferred,allowRecent\}\)/);
  assert.match(source, /^const \{preferred,allowRecent\}=verifyChoice\(\);$/m);
  assert.match(source, /for\(const sample of sequence\.samples\)\{\n  await seek\(sample\.position\);/);
  assert.match(source, /await seek\(follow\.start\);\n await expect\(room\)\.toHaveAttribute\('data-current-passage',follow\.passage\);/);
  assert.match(source, /if\(loaded\.id!==sequence\.trackId\)throw/);
  assert.doesNotMatch(source, /pickMappedIntervals|middle\.position-20/, "the check computes no seek target of its own");
  // A selected recording that fails stays a failure: there is no retry loop around the browser part.
  assert.equal((source.match(/selectReaderRecording\(/g) || []).length, 1);
});

test("the no-suitable-recording exit code is the one deploy.sh reports as skipped", () => {
  const deploy = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "deploy.sh"), "utf8");
  assert.match(deploy, new RegExp(`^no_suitable_exit=${NO_SUITABLE_RECORDING_EXIT}$`, "m"));
  assert.notEqual(NO_SUITABLE_RECORDING_EXIT, 1);
  const error = new NoSuitableRecording("no aligned recording(s) in the library");
  assert.equal(error.message, "no suitable recording: no aligned recording(s) in the library");
  assert.equal(error.reason, "no aligned recording(s) in the library");
});

test("only the selection functions throw NoSuitableRecording; the scripts turn nothing else into exit 3", () => {
  const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
  for (const name of ["verify-integrated-reader.mjs", "verify-playback-workflow.mjs"]) {
    const source = readFileSync(join(scripts, name), "utf8");
    assert.doesNotMatch(source, /new NoSuitableRecording/, name);
    assert.equal((source.match(/NO_SUITABLE_RECORDING_EXIT/g) || []).length, 2, `${name}: imported once, set once, under instanceof NoSuitableRecording`);
    assert.match(source, /if\s*\(\s*error instanceof NoSuitableRecording\s*\)\s*\{/, name);
  }
});

// #730 third round. A work of GET /api/library as tests/browser-server.ts answers it (tests/e2e/reader-second-track.spec.ts),
// cut to the fields the selection reads: Now playing's Read opens `chosenEbookId` (the shared default) over this
// device's choice, which is all the check can set.
function work(b, { chosenEbookId = null, ebooks } = {}) {
  return {
    workId: b.workId,
    title: b.title,
    author: b.author,
    inLibrary: true,
    chosenRecordingId: b.recordingId,
    chosenEbookId,
    ebooks: ebooks ?? [{ id: `upload-${b.id}`, format: "epub", size: 2286, available: true, check: null, place: null }],
  };
}
const edition = (id, extra = {}) => ({ id, format: "epub", size: 2286, available: true, check: null, place: null, ...extra });

test("#730: with a shared default edition, the check samples that edition's map, not a newer one of another edition", async () => {
  const b = book("phlebas", { tracks: [{ id: "torbox-139759793-1", duration: 29377.84 }, { id: "torbox-139759793-0", duration: 29739.33 }], progress: { track: 1, position: 28540.56 } });
  const intervals = (paragraph) => sentences("torbox-139759793-0", 0, 600).map((i) => ({ ...i, paragraphId: `${paragraph}:${i.start}` }));
  const spare = job(b, { ebookId: "libgen-spare", status: "ready", updatedAt: 1794748752999, intervals: intervals(11) });
  const shared = job(b, { ebookId: "libgen-shared", status: "partial", updatedAt: 1794748752000, intervals: intervals(12) });
  const ebooks = [ebook(b, { id: "libgen-spare" }), ebook(b, { id: "libgen-shared" })];
  const listing = { ...listingOf([{ book: b, ebooks, jobs: [spare, shared] }]), works: [work(b, { chosenEbookId: "libgen-shared", ebooks: [edition("libgen-spare"), edition("libgen-shared")] })] };
  // Without the shared default the ready, newer map comes first, as before.
  assert.deepEqual(rec.readerPairs({ ...listing, works: [work(b, { ebooks: [edition("libgen-spare"), edition("libgen-shared")] })] }).pairs.map((p) => p.job.ebookId), ["libgen-spare", "libgen-shared"]);
  assert.deepEqual(rec.readerPairs(listing).pairs.map((p) => p.job.ebookId), ["libgen-shared"]);
  const pick = await select(listing);
  assert.equal(pick.ebook.id, "libgen-shared");
  assert.equal(pick.job.id, shared.id);
});

test("#730: a shared default without a finished map of the recording rejects the recording, naming the edition", async () => {
  const b = book("shared-unmapped");
  const listing = { ...listingOf([{ book: b, ebooks: [ebook(b), ebook(b, { id: "libgen-other" })] }]), works: [work(b, { chosenEbookId: "libgen-other", ebooks: [edition(`upload-${b.id}`), edition("libgen-other")] })] };
  const result = rec.readerPairs(listing);
  assert.deepEqual(result.pairs, []);
  assert.match(result.rejected[0].reason, /Read opens the shared default EPUB libgen-other, which has no finished map of this recording/);
  await assert.rejects(select(listing), (error) => error instanceof NoSuitableRecording && /libgen-other/.test(error.message));
});

test("#730: a shared default Read cannot open (no file on the server, not an EPUB) leaves the device's choice to the check", () => {
  for (const shared of [edition("libgen-gone", { available: false }), edition("libgen-pdf", { format: "pdf" })]) {
    const b = book(`shared-${shared.id}`);
    const listing = { ...listingOf([{ book: b }]), works: [work(b, { chosenEbookId: shared.id, ebooks: [edition(`upload-${b.id}`), shared] })] };
    assert.equal(rec.sharedEdition(listing.works, b.workId), null);
    assert.deepEqual(rec.readerPairs(listing).pairs.map((p) => p.job.ebookId), [`upload-${b.id}`]);
  }
  assert.equal(rec.sharedEdition([], "work-none"), null);
});

test("#730: GET /api/library must answer a list of works; another shape fails the check", async () => {
  const b = book("library-shape");
  await assert.rejects(select(listingOf([{ book: b }]), {}, { "/api/library": { works: [] } }), (error) => !(error instanceof NoSuitableRecording) && /GET \/api\/library answered with an unexpected shape/.test(error.message));
  await assert.rejects(select(listingOf([{ book: b }]), {}, { "/api/library": { status: 500, body: {} } }), (error) => !(error instanceof NoSuitableRecording) && error.message === "GET /api/library answered 500");
});

test("#730: the reader check stops when Read opened another EPUB than the sampled map's", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/verify-integrated-reader.mjs"), "utf8");
  assert.match(source, /room\.getAttribute\('data-ebook'\)/);
  assert.match(source, /if\(opened!==ebook\.id\)\{[\s\S]{0,200}throw Error\(`Read opened EPUB/);
});

// #742: the check picked The Butcher's Masquerade's job a5807734, whose reading sync was cancelled at 20% with no
// published map, and failed at "Back to narration is off while following". Only a finished map counts: ready, or
// partial (published as it is), as the listing serves it.
const UNFINISHED = ["queued", "copying", "processing", "paused", "cancelled", "error"];

test("#742: a job that is not a finished map (cancelled, paused, failed, running) is rejected even with intervals at progress 1", async () => {
  for (const status of UNFINISHED) {
    const b = book(`status-${status}`);
    const listing = listingOf([{ book: b, jobs: [job(b, { status, progress: 1 })] }]);
    assert.equal(rec.finishedMap(listing.jobs[0]), false, status);
    assert.deepEqual(rec.readerPairs(listing).pairs, [], status);
    await assert.rejects(select(listing), (error) => error instanceof NoSuitableRecording && error.reason === "no aligned recording(s) in the library", status);
    // Named, it says which map and what it is.
    const named = rec.readerPairs(listing, { preferred: b.recordingId }).rejected;
    assert.deepEqual(named.map((r) => r.reason), [`no finished EPUB alignment map (map ${listing.jobs[0].id} of EPUB upload-${b.id}: ${status})`], status);
  }
  for (const status of ["ready", "partial"]) {
    const b = book(`status-${status}`);
    assert.equal(rec.finishedMap(job(b, { status })), true, status);
    assert.equal((await select(listingOf([{ book: b, jobs: [job(b, { status })] }]))).job.status, status);
  }
});

test("#742 incident: the cancelled job of The Butcher's Masquerade is passed over for Consider Phlebas's partial map of its shared default", async () => {
  const butcher = book("torbox-135287188", { progress: { position: 300 } });
  const phlebas = book("torbox-139759793", { tracks: [{ id: "torbox-139759793-1", duration: 29377.84 }, { id: "torbox-139759793-0", duration: 29739.33 }], progress: { track: 1, position: 300 } });
  // The cancelled job is newer and has the intervals it made before it was cancelled (a listing that showed them).
  const cancelled = job(butcher, { ebookId: "libgen-1dafeaa8", id: "a5807734", status: "cancelled", progress: 0.2, updatedAt: 1794748753999, intervals: sentences(butcher.tracks[0].id, 0, 600) });
  const cancelledAtOne = { ...cancelled, progress: 1 };
  const partial = job(phlebas, { ebookId: "libgen-9719e452", status: "partial", updatedAt: 1794748752000, intervals: sentences("torbox-139759793-0", 0, 600) });
  for (const butcherJob of [cancelled, cancelledAtOne]) {
    const listing = {
      ...listingOf([
        { book: butcher, ebooks: [ebook(butcher, { id: "libgen-1dafeaa8" })], jobs: [butcherJob] },
        { book: phlebas, ebooks: [ebook(phlebas, { id: "libgen-9719e452" }), ebook(phlebas, { id: "libgen-4ee6dc25" })], jobs: [partial] },
      ]),
      works: [
        work(butcher, { chosenEbookId: "libgen-1dafeaa8", ebooks: [edition("libgen-1dafeaa8")] }),
        work(phlebas, { chosenEbookId: "libgen-9719e452", ebooks: [edition("libgen-9719e452"), edition("libgen-4ee6dc25")] }),
      ],
    };
    const { get, requests } = server(listing);
    const pick = await rec.selectReaderRecording(get);
    assert.equal(pick.recordingId, phlebas.recordingId);
    assert.equal(pick.ebook.id, "libgen-9719e452");
    // The cancelled job's map is not even asked for.
    assert.ok(!requests.includes(mapPath(butcherJob)));
    // Named, the cancelled recording is rejected and the check falls back to the other one, saying why.
    const preferred = await rec.selectReaderRecording(get, { preferred: butcher.recordingId });
    assert.equal(preferred.recordingId, phlebas.recordingId);
    assert.equal(preferred.preferred.reason, "no finished EPUB alignment map (map a5807734 of EPUB libgen-1dafeaa8: cancelled)");
  }
});

test("#742: a shared default whose only map of the recording is cancelled rejects the recording, though another edition has a ready map", async () => {
  const b = book("shared-cancelled");
  const other = job(b, { ebookId: "libgen-other", status: "ready", intervals: sentences(b.tracks[0].id, 0, 600) });
  const shared = job(b, { ebookId: "libgen-shared", status: "cancelled", intervals: sentences(b.tracks[0].id, 0, 600) });
  const listing = {
    ...listingOf([{ book: b, ebooks: [ebook(b, { id: "libgen-other" }), ebook(b, { id: "libgen-shared" })], jobs: [other, shared] }]),
    works: [work(b, { chosenEbookId: "libgen-shared", ebooks: [edition("libgen-other"), edition("libgen-shared")] })],
  };
  const result = rec.readerPairs(listing);
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.rejected.map((r) => r.reason), ["Read opens the shared default EPUB libgen-shared, which has no finished map of this recording"]);
  await assert.rejects(select(listing), (error) => error instanceof NoSuitableRecording && /libgen-shared/.test(error.message));
  // Without the shared default the device's choice (the ready map) is the check's.
  assert.equal((await select({ ...listing, works: [work(b, { ebooks: [edition("libgen-other"), edition("libgen-shared")] })] })).job.id, other.id);
});

test("#742: a map in use whose rebuild was cancelled is listed with its own status and qualifies", async () => {
  const b = book("kept-map");
  const kept = { ...job(b, { status: "ready", intervals: sentences(b.tracks[0].id, 0, 600) }), rebuild: { status: "cancelled", progress: 0.2, engine: "ctc", error: null } };
  assert.equal(rec.finishedMap(kept), true);
  assert.equal((await select(listingOf([{ book: b, jobs: [kept] }]))).job.id, kept.id);
});

test("#742: a map the listing showed finished but that is no longer finished when read is excluded; the next map is tried", async () => {
  const first = book("cancelled-since"), second = book("still-ready");
  const a = job(first, { status: "ready", updatedAt: 900, intervals: sentences(first.tracks[0].id, 0, 600) });
  const c = job(second, { status: "partial", updatedAt: 100, intervals: sentences(second.tracks[0].id, 0, 600) });
  const listing = listingOf([{ book: first, jobs: [a] }, { book: second, jobs: [c] }]);
  const pick = await select(listing, {}, { [mapPath(a)]: { ...a, status: "cancelled" } });
  assert.equal(pick.job.id, c.id);
  await assert.rejects(select(listingOf([{ book: first, jobs: [a] }]), {}, { [mapPath(a)]: { ...a, status: "error" } }), (error) => error instanceof NoSuitableRecording && /its map is error, not a finished map/.test(error.message));
});

// #742 second round. Production: the automatic pick took The Butcher's Masquerade (no shared default) and the guard
// stopped it: "Read opened EPUB libgen-201c3bd3fae6ce236da1ac4fe4d3cc9a, not libgen-1dafeaa80ffb53e64eaaf4d90d458c54 of
// the sampled map". The selection computes the edition Read opens by chosenEbook's rule (readEdition) with the device
// choice the check sets, and the check opens Read from the player that holds the selected book (no reload).
test("#742 round 2: readEdition answers as chosenEbook (src/ebook-choice.ts) does, for every shared default and device choice", async () => {
  const { chosenEbook } = await import("../src/ebook-choice.ts");
  const editions = [
    edition("libgen-201c"),
    edition("libgen-1daf"),
    edition("libgen-gone", { available: false }),
    edition("libgen-pdf", { format: "pdf" }),
  ];
  const ids = [null, undefined, "libgen-201c", "libgen-1daf", "libgen-gone", "libgen-pdf", "libgen-elsewhere"];
  const orders = [editions, [...editions].reverse(), editions.slice(2), []];
  let cases = 0;
  for (const ebooks of orders)
    for (const chosenEbookId of ids)
      for (const choice of ids) {
        const w = { workId: "work-x", chosenEbookId: chosenEbookId ?? null, ebooks };
        assert.equal(rec.readEdition(w, choice), chosenEbook(w, choice)?.id ?? null, JSON.stringify({ order: ebooks.map((e) => e.id), chosenEbookId, choice }));
        cases++;
      }
  assert.equal(cases, orders.length * ids.length * ids.length);
});

test("#742 round 2: with no shared default, the check samples the map of the EPUB its device choice opens, not the work's first EPUB", async () => {
  const b = book("torbox-135287188", { progress: { position: 300 } });
  const ready = job(b, { ebookId: "libgen-1dafeaa8", status: "ready", intervals: sentences(b.tracks[0].id, 0, 600) });
  const ebooks = [ebook(b, { id: "libgen-201c3bd3" }), ebook(b, { id: "libgen-1dafeaa8" })];
  const listing = { ...listingOf([{ book: b, ebooks, jobs: [ready] }]), works: [work(b, { ebooks: [edition("libgen-201c3bd3"), edition("libgen-1dafeaa8")] })] };
  const pick = await select(listing);
  assert.equal(pick.ebook.id, "libgen-1dafeaa8");
  // What Read opens with the device choice the check sets is the sampled map's EPUB.
  assert.equal(rec.readEdition(listing.works[0], pick.ebook.id), pick.ebook.id);
});

test("#742 round 2: a map whose EPUB Read would not open with the device choice set to it is rejected, naming the EPUB Read opens", async () => {
  const b = book("unopenable", { progress: { position: 300 } });
  const ready = job(b, { ebookId: "libgen-1dafeaa8", status: "ready", intervals: sentences(b.tracks[0].id, 0, 600) });
  // GET /api/ebooks says the file is there; the work as GET /api/library lists it (what Read chooses from) does not.
  const ebooks = [ebook(b, { id: "libgen-201c3bd3" }), ebook(b, { id: "libgen-1dafeaa8" })];
  for (const listed of [[edition("libgen-201c3bd3"), edition("libgen-1dafeaa8", { available: false })], [edition("libgen-201c3bd3")]]) {
    const listing = { ...listingOf([{ book: b, ebooks, jobs: [ready] }]), works: [work(b, { ebooks: listed })] };
    const result = rec.readerPairs(listing);
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.rejected.map((r) => r.reason), [`Read opens libgen-201c3bd3 of the work, not the EPUB of a finished map (map ${ready.id} of EPUB libgen-1dafeaa8: not an EPUB on the server in GET /api/library)`]);
    await assert.rejects(select(listing), (error) => error instanceof NoSuitableRecording && /Read opens libgen-201c3bd3/.test(error.message));
  }
  // Of two finished maps only the one of an edition Read opens is sampled.
  const other = job(b, { ebookId: "libgen-201c3bd3", status: "partial", updatedAt: 1, intervals: sentences(b.tracks[0].id, 0, 600) });
  const listing = { ...listingOf([{ book: b, ebooks, jobs: [ready, other] }]), works: [work(b, { ebooks: [edition("libgen-201c3bd3")] })] };
  assert.deepEqual(rec.readerPairs(listing).pairs.map((p) => p.job.id), [other.id]);
});

test("#742 round 2: a recording whose work is not in GET /api/library is rejected: the edition Read opens is unknown", async () => {
  const b = book("no-work", { progress: { position: 300 } });
  const listing = { ...listingOf([{ book: b, jobs: [job(b, { status: "ready", intervals: sentences(b.tracks[0].id, 0, 600) })] }]), works: [] };
  assert.deepEqual(rec.readerPairs(listing).rejected.map((r) => r.reason), [`its work ${b.workId} is not in GET /api/library, so the edition Read opens is unknown`]);
  await assert.rejects(select(listing), (error) => error instanceof NoSuitableRecording && /is not in GET \/api\/library/.test(error.message));
});

test("#742 round 2: the reader check opens Read from the player holding the selected book, not after a reload", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/verify-integrated-reader.mjs"), "utf8");
  const listen = source.indexOf("getByRole('button',{name:'Listen',exact:true}).click()");
  const read = source.indexOf("await openRead();", listen);
  assert.ok(listen > 0 && read > listen);
  const between = source.slice(listen, read);
  // No navigation that reloads the app (the dock would show App.tsx's `featured`, the latest saved progress).
  assert.doesNotMatch(between, /page\.(goto|reload)\(/);
  assert.match(between, /location\.hash='#library'/);
  assert.match(between, /\.player-dock \.dock-book.*toContainText\(book\.title\)/);
  assert.match(source.slice(read), /if\(readWork!==book\.workId\)throw Error/);
});

// #744: the reader check asserted "Back to narration is off while following" at the saved position. Before a partial
// map's first sentence (an unmapped intro, or no saved progress: the first file at 0) the reader has no narrated
// sentence there, and the administrator's Back to narration is on to locate the passage (#592), so the check reported
// "the reader follows nothing". readerSequence now says whether the saved position has a narrated sentence, by the
// reader's own rule, and the check moves to its first mapped sample first when it has none.
test("narratedAt gives the reader's narrated sentence (narratedSentence) at every place, and none before the first sentence (#744)", async () => {
  const { createReaderFollowing } = await import("../src/reader-following.ts");
  const following = createReaderFollowing({ onManualSave() {}, onRetry() {}, onClearFollowError() {} });
  const tracks = ["t0", "t1", "t2"];
  const intervals = [
    mapped("t1", 40, 46, "b"), mapped("t0", 30, 36, "a"), mapped("t1", 40, 47, "b2"), mapped("t1", 90, 96, "c"),
    mapped("gone", 1, 2, "x"), mapped("t2", 5, 9, "d"),
  ];
  const map = { recordingId: "r", intervals };
  for (const trackId of [...tracks, "other"])
    for (const position of [0, 5, 29.9, 30, 35, 39.9, 40, 41, 90, 200]) {
      const reader = following.narratedSentence(map, { recordingId: "r", tracks, trackId, position });
      assert.equal(rec.narratedAt(intervals, tracks, trackId, position), reader, `${trackId} at ${position}`);
    }
  assert.equal(rec.narratedAt(intervals, tracks, "t0", 10), null, "before the map's first sentence");
  assert.equal(rec.narratedAt(intervals, tracks, "t1", 10)?.paragraphId, "a", "an earlier file's sentence is still narrated");
});

test("readerSequence says whether the saved position has a narrated sentence: not before a partial map's first one (#744)", () => {
  // The Butcher's Masquerade shape: no saved progress, so the first file at 0, and the map's first sentence after an
  // unmapped intro.
  const fresh = book("butcher", { tracks: [{ duration: 3000 }] });
  const intro = rec.readerSequence(sentences(fresh.tracks[0].id, 45, 600), fresh);
  assert.equal(intro.reason, undefined, intro.reason);
  assert.equal(intro.startNarrated, false);
  assert.ok(intro.samples[0].position > 45, "the check moves to a mapped sample before it asserts the reader follows");
  const listened = book("listened", { tracks: [{ duration: 3000 }], progress: { track: 0, position: 300 } });
  assert.equal(rec.readerSequence(sentences(listened.tracks[0].id, 45, 600), listened).startNarrated, true);
  // A sentence on an earlier file is narrated at the start of the next one.
  const tracks = [{ duration: 600 }, { duration: 3000 }];
  const into = book("into744", { tracks, progress: { track: 1, position: 5 } });
  assert.equal(rec.readerSequence([mapped(into.tracks[0].id, 500, 503), ...sentences(into.tracks[1].id, 10, 400)], into).startNarrated, true);
});

// #774: the deploy's check chose whatever aligned book came first, and tonight that was the one the owner was
// listening to (recording-torbox-139288314, The Gate of the Feral Gods, progress saved minutes before); the last
// check happened to choose Excession. A fixed clock, so the hour-ago saves stay an hour ago.
const NOW = 1795600000000;
const HOUR = 60 * 60 * 1000;

test("#774: with the owner's current book first in the listing, played an hour ago, the check chooses another aligned book", async () => {
  const gate = book("torbox-139288314", { progress: { position: 42, updatedAt: NOW - HOUR } });
  const excession = book("excession", { progress: { position: 42, updatedAt: NOW - 5 * 24 * HOUR } });
  const listing = listingOf([
    { book: gate, jobs: [job(gate, { status: "ready", updatedAt: 900 })] },
    { book: excession, jobs: [job(excession, { status: "partial", updatedAt: 100 })] },
  ]);
  const { pairs, rejected } = rec.readerPairs(listing, { now: NOW });
  assert.deepEqual(pairs.map((p) => p.book.recordingId), [excession.recordingId]);
  assert.deepEqual(rejected, [{ recordingId: gate.recordingId, reason: "listened to in the last 48 h" }]);
  const { get, requests } = server(listing);
  const pick = await rec.selectReaderRecording(get, { now: NOW });
  assert.equal(pick.recordingId, excession.recordingId);
  assert.ok(!requests.includes(mapPath(listing.jobs[0])), "the map of the book being listened to is not even fetched");
});

test("#774: every recording of a work with a recently played recording is skipped too, with the recording named", () => {
  const listened = book("release-a", { workId: "work-shared", progress: { position: 42, updatedAt: NOW - 2 * HOUR } });
  const sibling = book("release-b", { workId: "work-shared", progress: { position: 42, updatedAt: NOW - 30 * 24 * HOUR } });
  const unplayed = book("release-c", { workId: "work-shared" });
  const elsewhere = book("other", { progress: { position: 42, updatedAt: NOW - 30 * 24 * HOUR } });
  const listing = listingOf([{ book: sibling }, { book: unplayed }, { book: listened }, { book: elsewhere }]);
  const { pairs, rejected } = rec.readerPairs(listing, { now: NOW });
  assert.deepEqual(pairs.map((p) => p.book.recordingId), [elsewhere.recordingId]);
  assert.deepEqual(rejected, [
    { recordingId: sibling.recordingId, reason: "listened to in the last 48 h (recording recording-release-a of the same work)" },
    { recordingId: unplayed.recordingId, reason: "listened to in the last 48 h (recording recording-release-a of the same work)" },
    { recordingId: listened.recordingId, reason: "listened to in the last 48 h" },
  ]);
});

test("#774: the window is 48 hours of saved progress; a save from another device's clock ahead counts as recent", () => {
  assert.equal(rec.RECENT_LISTENING_MS, 48 * HOUR);
  const at = (updatedAt) => rec.recentlyListened([book("b", { progress: { position: 1, updatedAt } })], NOW).has("work-b");
  assert.equal(at(NOW - 48 * HOUR), true);
  assert.equal(at(NOW - 48 * HOUR - 1), false);
  assert.equal(at(NOW + 60_000), true);
  assert.equal(rec.recentlyListened([book("never")], NOW).size, 0, "no progress, nothing listened to");
  // The latest save of the work is the one named.
  const two = rec.recentlyListened([book("x", { workId: "w", progress: { position: 1, updatedAt: NOW - 3 * HOUR } }), book("y", { workId: "w", progress: { position: 1, updatedAt: NOW - HOUR } })], NOW);
  assert.deepEqual(two.get("w"), { recordingId: "recording-y", updatedAt: NOW - HOUR });
});

test("#774: when only recently played books are aligned, the check finds no suitable recording (exit 3) and says why", async () => {
  const gate = book("torbox-139288314", { progress: { position: 42, updatedAt: NOW - HOUR } });
  await assert.rejects(rec.selectReaderRecording(server(listingOf([{ book: gate }])).get, { now: NOW }), (error) => {
    assert.ok(error instanceof NoSuitableRecording);
    assert.equal(error.reason, "1 aligned recording(s) in the library, none qualifies: recording-torbox-139288314: listened to in the last 48 h");
    return true;
  });
});

test("#774: an explicit choice of a recently played recording is refused, before anything but the book listing is read", async () => {
  const gate = book("torbox-139288314", { progress: { position: 42, updatedAt: NOW - HOUR } });
  const excession = book("excession", { progress: { position: 42, updatedAt: NOW - 5 * 24 * HOUR } });
  const listing = listingOf([{ book: gate }, { book: excession }]);
  const { get, requests } = server(listing);
  await assert.rejects(rec.selectReaderRecording(get, { preferred: gate.recordingId, now: NOW }), (error) => {
    assert.ok(error instanceof rec.RecentChoiceRefused);
    assert.ok(!(error instanceof NoSuitableRecording), "a refusal is a failure (exit 1), not a skip");
    assert.equal(error.message, "refusing to check recording recording-torbox-139288314: listened to in the last 48 h, and a live check could clash with that listening; set SONDER_VERIFY_ALLOW_RECENT=1 to check it anyway");
    return true;
  });
  assert.deepEqual(requests, ["/api/books"]);
  // A sibling recording of the work is refused the same way.
  const sibling = book("sibling", { workId: gate.workId });
  await assert.rejects(rec.selectReaderRecording(server(listingOf([{ book: gate }, { book: sibling }])).get, { preferred: sibling.recordingId, now: NOW }), /refusing to check recording recording-sibling: listened to in the last 48 h \(recording recording-torbox-139288314 of the same work\)/);
});

test("#774: SONDER_VERIFY_ALLOW_RECENT lets the explicit choice be a recently played recording, and only that one", async () => {
  const gate = book("torbox-139288314", { progress: { position: 42, updatedAt: NOW - HOUR } });
  const other = book("other-recent", { progress: { position: 42, updatedAt: NOW - HOUR } });
  const listing = listingOf([{ book: other, jobs: [job(other, { status: "ready", updatedAt: 900 })] }, { book: gate }]);
  const pick = await select(listing, { preferred: gate.recordingId, allowRecent: true, now: NOW });
  assert.equal(pick.recordingId, gate.recordingId);
  const { pairs, rejected } = rec.readerPairs(listing, { preferred: gate.recordingId, allowRecent: true, now: NOW });
  assert.deepEqual(pairs.map((p) => p.book.recordingId), [gate.recordingId]);
  assert.deepEqual(rejected, [{ recordingId: other.recordingId, reason: "listened to in the last 48 h" }]);
  // Without an explicit choice the switch frees nothing.
  await assert.rejects(select(listing, { allowRecent: true, now: NOW }), NoSuitableRecording);
});

test("#774: an explicit choice that was not played recently still wins over the chooser's own order", async () => {
  const named = book("named", { progress: { position: 42, updatedAt: NOW - 3 * 24 * HOUR } });
  const other = book("other", { progress: { position: 42, updatedAt: NOW - 3 * 24 * HOUR } });
  const listing = listingOf([{ book: other, jobs: [job(other, { status: "ready", updatedAt: 900 })] }, { book: named, jobs: [job(named, { status: "partial", updatedAt: 100 })] }]);
  assert.equal((await select(listing, { preferred: named.recordingId, now: NOW })).recordingId, named.recordingId);
  assert.equal((await select(listing, { now: NOW })).recordingId, other.recordingId);
});

test("#774: the explicit choice is the first argument, else SONDER_VERIFY_RECORDING; only SONDER_VERIFY_ALLOW_RECENT=1 allows a recent one", () => {
  assert.deepEqual(rec.verifyChoice([], {}), { preferred: null, allowRecent: false });
  assert.deepEqual(rec.verifyChoice([], { SONDER_VERIFY_RECORDING: "recording-x" }), { preferred: "recording-x", allowRecent: false });
  assert.deepEqual(rec.verifyChoice(["recording-arg"], { SONDER_VERIFY_RECORDING: "recording-x" }), { preferred: "recording-arg", allowRecent: false });
  // deploy.sh passes both through, empty when unset.
  assert.deepEqual(rec.verifyChoice([], { SONDER_VERIFY_RECORDING: "", SONDER_VERIFY_ALLOW_RECENT: "" }), { preferred: null, allowRecent: false });
  assert.equal(rec.verifyChoice([], { SONDER_VERIFY_ALLOW_RECENT: "1" }).allowRecent, true);
  assert.equal(rec.verifyChoice([], { SONDER_VERIFY_ALLOW_RECENT: "true" }).allowRecent, false);
});

test("#774: the multi-user check's temporary user works on a book the administrator did not play in the last 48 h", () => {
  const strip = ({ progress, ...rest }) => rest;
  const gate = book("torbox-139288314", { progress: { position: 42, updatedAt: NOW - HOUR } });
  const quiet = book("quiet", { progress: { position: 42, updatedAt: NOW - 5 * 24 * HOUR } });
  const noTracks = book("placeholder", { tracks: [] });
  const user = [noTracks, gate, quiet].map(strip);
  assert.deepEqual(rec.multiUserPlayable(user, [gate, quiet, noTracks], NOW), { book: user[2], recent: null });
  // Every title with audio was played: the first is used (the user's writes stay the user's), and the report says so.
  assert.deepEqual(rec.multiUserPlayable([noTracks, gate].map(strip), [gate], NOW), { book: strip(gate), recent: "listened to in the last 48 h" });
  assert.deepEqual(rec.multiUserPlayable([strip(noTracks)], [], NOW), { book: null, recent: null });
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/verify-multi-user.mjs"), "utf8");
  assert.match(source, /const \{book:playable,recent:playableRecent\}=multiUserPlayable\(qaBooks,adminCatalogue\);/);
  assert.doesNotMatch(source, /qaBooks\.find\(b=>b\.tracks\?\.length\)/, "no chooser of its own");
});
