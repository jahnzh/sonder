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
const listingOf = (entries) => ({
  books: entries.map((e) => e.book),
  ebooks: entries.flatMap((e) => e.ebooks ?? [ebook(e.book)]),
  jobs: entries.flatMap((e) => e.jobs ?? [job(e.book)]),
});

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
  assert.deepEqual(requests, ["/api/books", "/api/ebooks", "/api/alignments"], "no map is fetched for a recording that cannot qualify");
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
  const context = { request: { get: async (path) => { if (path.endsWith("/map")) throw new Error("apiRequestContext.get: Timeout 30000ms exceeded."); return { status: () => 200, text: async () => JSON.stringify(path === "/api/books" ? listing.books : path === "/api/ebooks" ? listing.ebooks : { jobs: listing.jobs }) }; } } };
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
  assert.deepEqual(requests.slice(3), [mapPath(jobA), mapPath(jobB)]);
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
  assert.match(source, /selectReaderRecording\(get,\{preferred\}\)/);
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
