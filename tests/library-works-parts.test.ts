// The rest of what a work holds (#487) in both reads by work: ebook editions, reading sync, series,
// media state, completion and the Hardcover block, on the fixture of `tests/library-works-fixture.ts`
// plus the rows below, read as the owner (the administrator) and as Sam (a user).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Book, LibraryWork, ReadingSyncSummary } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";
import { DAY, OWNER, OWNER_TOKEN, SAM, SAM_TOKEN, T0, writeLibraryFixture } from "./library-works-fixture.ts";

const temp = tempDir("sonder-library-parts-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.ALIGNMENT_WORKER_TOKEN;

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const media = process.env.MEDIA_ROOT;
writeLibraryFixture(sqlite, media, hashToken);
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const ebookPath = (name: string) => join(media, "fixture", name);
const ebook = (id: string, workId: string, format: string, file: string | null) => {
  const source = ebookPath(`${id}.${format}`);
  if (file !== null) writeFileSync(source, file);
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,?,?)", id, workId, format, source);
  return source;
};
const checkpoint = (userId: number, editionId: string, progression: number, origin: "reading" | "listening" | null, updatedAt: number) =>
  run(
    `INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(?,?,?)
     ON CONFLICT(user_id,edition_id) DO UPDATE SET data=excluded.data`,
    userId,
    editionId,
    JSON.stringify({
      locator: { section: 0, paragraphId: "0:0", progression },
      revision: 1,
      eventId: `event-${editionId}-${updatedAt}`,
      deviceId: "test-device",
      updatedAt,
      ...(origin ? { origin } : {}),
    }),
  );
const member = (workId: string, ebookId: string, status: string, holdReason: string | null) =>
  run(
    `INSERT INTO work_ebook_set_members(work_id,ebook_id,status,hold_reason,evidence,updated_at) VALUES(?,?,?,?,'{}',?)
     ON CONFLICT(work_id,ebook_id) DO UPDATE SET status=excluded.status,hold_reason=excluded.hold_reason`,
    workId,
    ebookId,
    status,
    holdReason,
    T0,
  );
/** An alignment job as stored, with the parts that stay on the alignment routes (steps, workers, stage times). */
const alignment = (
  id: string,
  ebookId: string,
  recordingId: string,
  status: string,
  progress: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  ebookId,
  recordingId,
  status,
  progress,
  engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2",
  error: null,
  warning: null,
  intervals: [
    { start: 0, end: 4, fragment: "0:0" },
    { start: 4, end: 9, fragment: "0:1" },
  ],
  sectionsDone: [0],
  elapsedSeconds: 12,
  fingerprint: `text-${ebookId}`,
  audioFingerprint: `audio-v2:${recordingId}`,
  updatedAt: T0,
  createdAt: T0,
  coverage: 0.97,
  pairings: [{ section: 0, trackId: "t-two-a-0", start: 0, duration: 600 }],
  mode: "anchored",
  anchoring: { stage: "aligning", refinements: 0, samples: [], anchors: [], segments: [], rate: 1, flags: [] },
  stageTimings: { align: 3.5 },
  pool: { hostId: "wsl", attempt: 1, jobMediaRoot: "/srv/pool/job", workerUrl: "http://127.0.0.1:3012", triedHosts: ["wsl"], stagedAudio: {} },
  ...extra,
});
const job = (data: ReturnType<typeof alignment>, updatedAt: number, publishedMap: ReturnType<typeof alignment> | null = null) =>
  run(
    `INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at,engine,published_map) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,published_map=excluded.published_map`,
    data.id,
    data.ebookId,
    data.recordingId,
    JSON.stringify(data),
    updatedAt,
    data.engine,
    publishedMap && JSON.stringify(publishedMap),
  );
const acquisition = (id: string, workId: string, status: string, progress: number, error: string | null, users: number[]) => {
  run(
    `INSERT INTO acquisitions(id,hash,magnet,backend,title,author,cover,status,progress,error,created_at,updated_at,work_id)
     VALUES(?,?,'magnet:?xt=urn:btih:fixture','local','A','B','',?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status,progress=excluded.progress,error=excluded.error,updated_at=excluded.updated_at`,
    id,
    `hash-${id}`,
    status,
    progress,
    error,
    T0,
    T0 + progress,
    workId,
  );
  for (const userId of users) run("INSERT OR IGNORE INTO user_acquisitions(user_id,acquisition_id) VALUES(?,?)", userId, id);
};
/** A work whose only audio edition is a placeholder, in `users`' libraries. */
const placeholderWork = (workId: string, editionId: string, users: number[], addedAt: number) => {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", workId, workId, "A", "D", "G", 2010);
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
    editionId,
    workId,
    `/covers/${workId}.jpg`,
    "Audio not added",
    null,
    null,
    0,
    "Hardcover library",
  );
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `recording-${editionId}`, editionId);
  for (const userId of users)
    run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", userId, editionId, addedAt);
};

// w-epub: only an EPUB (and a PDF whose file is missing) beside a placeholder, the owner's place in the EPUB.
placeholderWork("w-epub", "hc-201", [OWNER], T0 + 14 * DAY);
const epubSource = ebook("eb-epub", "w-epub", "epub", "epub bytes");
ebook("eb-pdf", "w-epub", "pdf", null);
checkpoint(OWNER, "eb-epub", 0.4, "reading", T0 + 15 * DAY);

// w-two: two EPUBs in its ebook set (the default accepted, the other held), the set's consensus text,
// a ready reading sync pair (rec-two-a) and one being rebuilt (rec-two-b), and two Hardcover series.
ebook("eb-two", "w-two", "epub", "two epub");
ebook("eb-two-held", "w-two", "epub", "held epub!");
run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('set-consensus:w-two','w-two','epub','consensus:w-two')");
checkpoint(OWNER, "set-consensus:w-two", 1, "reading", T0 + 16 * DAY);
member("w-two", "eb-two", "accepted", null);
member("w-two", "eb-two-held", "held", "awaiting_audio");
run(
  "INSERT INTO work_ebook_set(work_id,consensus_sentences,projections,default_ebook_id,updated_at) VALUES('w-two','[]','{}','eb-two',?)",
  T0,
);
job(alignment("job-ready", "eb-two", "rec-two-a", "ready", 1), T0 + 1);
// A projected map (ADR 0004) of the held member: a pair with a job too.
job(alignment("job-projected", "eb-two-held", "rec-two-a", "ready", 1, { origin: "projected", coverage: 0.5 }), T0 + 5);
// The consensus job of the set, and a job of a recording outside the owner's library: neither is listed.
job(alignment("job-consensus", "set-consensus:w-two", "rec-two-a", "ready", 1), T0 + 2);
ebook("eb-outside", "w-outside", "epub", "outside");
job(alignment("job-outside", "eb-outside", "rec-outside", "ready", 1), T0 + 3);
// The rebuild runs in the row; the map it keeps serving is the published one.
job(
  alignment("job-rebuild", "eb-two", "rec-two-b", "processing", 0.3, { rebuildOf: { engine: "old", status: "ready", requestedAt: T0 } }),
  T0 + 4,
  alignment("job-rebuild", "eb-two", "rec-two-b", "ready", 1, { engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v2" }),
);
run("UPDATE hardcover_links SET series=? WHERE work_id='w-two'", JSON.stringify([
  { id: 77, name: "Pair Saga", position: 1 },
  { id: 88, name: "Wider World", position: 4.5 },
  { name: "Unnumbered Cycle", position: null },
]));
run("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(77,'Pair Saga','A',2),(88,'Wider World','A',9)");
run("INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(?,88,?)", OWNER, T0);
run("INSERT INTO user_hardcover_links(user_id,book_id,status_id) VALUES(?,9001,3)", OWNER);
run("INSERT INTO user_hardcover_links(user_id,book_id,status_id) VALUES(?,9001,1)", SAM);
run(
  "INSERT INTO user_hardcover_lists(user_id,id,account_id,name,members,synced_at) VALUES(?,5,1,'Favourites',?,?)",
  OWNER,
  JSON.stringify([{ id: 1, bookId: 9001 }]),
  T0,
);

// Media states: queued (both users share the acquisition), failed (the owner's only), held (w-only, in the fixture).
placeholderWork("w-queued", "hc-202", [OWNER, SAM], T0 + 17 * DAY);
acquisition("acq-queued", "w-queued", "downloading", 0.42, null, [OWNER, SAM]);
placeholderWork("w-failed", "hc-203", [OWNER, SAM], T0 + 18 * DAY);
const failure = "Transmission: No data found! Ensure your drives are connected (/srv/torrents/w-failed)";
acquisition("acq-failed", "w-failed", "error", 0.1, failure, [OWNER, SAM]);

const { createApp } = await import("../server/app.ts");
const { filePresence } = await import("../server/library-works.ts");
const app = await createApp({ background: { manual: true } });
let clock = Date.now();
filePresence.now = () => clock;

after(async () => {
  await app.close();
  sqlite.close();
});

const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({ url, headers, cookies: { sonder_session: token } });
async function library(token: string) {
  const response = await get("/api/library", token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork[];
}
async function work(token: string, workId: string) {
  const response = await get(`/api/works/${workId}`, token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LibraryWork;
}
/** The work through both reads, which must agree; the one-work read alone for a work outside the library. */
async function bothReads(token: string, workId: string) {
  const one = await work(token, workId);
  const listed = (await library(token)).find((w) => w.workId === workId);
  if (one.inLibrary) assert.deepEqual(listed, one, `${workId}: both reads give the same work`);
  else assert.equal(listed, undefined);
  return one;
}

test("a work with only an EPUB and a place in it, beside a PDF edition whose file is missing", async () => {
  const epub = await bothReads(OWNER_TOKEN, "w-epub");
  assert.deepEqual(epub.recordings, []);
  assert.equal(epub.chosenRecordingId, null);
  assert.equal(epub.chosenEbookId, null, "a work without an ebook set has no shared default");
  assert.deepEqual(epub.ebooks, [
    {
      id: "eb-epub",
      format: "epub",
      size: "epub bytes".length,
      available: true,
      check: null,
      place: { progression: 0.4, origin: "reading", updatedAt: T0 + 15 * DAY },
    },
    { id: "eb-pdf", format: "pdf", size: 0, available: false, check: null, place: null },
  ]);
  assert.equal(epub.finished, false);
  assert.deepEqual(epub.readingSync, []);
  // Format, size and whether the file is there are what the ebook list gives every user.
  const listed = (await get("/api/ebooks", SAM_TOKEN)).json() as { id: string; format: string; size: number; available: boolean }[];
  for (const edition of epub.ebooks) {
    const entry = listed.find((e) => e.id === edition.id);
    assert.deepEqual({ format: entry?.format, size: entry?.size, available: entry?.available }, {
      format: edition.format,
      size: edition.size,
      available: edition.available,
    });
  }
});

test("ebook editions carry their check against the narration and the shared default; the consensus text is not one", async () => {
  const two = await bothReads(OWNER_TOKEN, "w-two");
  assert.deepEqual(two.ebooks.map((e) => e.id), ["eb-two", "eb-two-held"]);
  assert.deepEqual(two.ebooks.map((e) => e.check), [
    { status: "accepted", holdReason: null },
    { status: "held", holdReason: "awaiting_audio" },
  ]);
  assert.equal(two.chosenEbookId, "eb-two");
  const set = (await get("/api/works/w-two/ebook-set", SAM_TOKEN)).json() as {
    defaultEbookId: string;
    members: { ebookId: string; status: string; holdReason: string | null }[];
  };
  assert.equal(set.defaultEbookId, two.chosenEbookId, "the default is the ebook-set route's");
  for (const edition of two.ebooks) {
    const entry = set.members.find((m) => m.ebookId === edition.id);
    assert.deepEqual(edition.check, { status: entry?.status, holdReason: entry?.holdReason });
  }
  // The owner's checkpoint in the consensus text neither lists it nor finishes the work.
  for (const token of [OWNER_TOKEN, SAM_TOKEN]) {
    const body = (await get("/api/works/w-two", token)).body;
    assert.ok(!body.includes("set-consensus:"), "no consensus text in the read");
    assert.ok(!(await get("/api/library", token)).body.includes("set-consensus:"));
  }
  assert.equal(two.finished, false);
});

const omitted = [
  "anchoring",
  "pairings",
  "sectionsDone",
  "pool",
  "poolErrors",
  "bookJob",
  "runConfig",
  "ctcDevice",
  "ctcPrecision",
  "gpuUtilization",
  "gpuUtilizationSamples",
  "stageTimings",
  "elapsedSeconds",
];
async function alignmentList(token: string) {
  const response = await get("/api/alignments?summary=1", token);
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { jobs: (ReadingSyncSummary & Record<string, unknown>)[] }).jobs;
}

test("reading sync: one entry per pair with a job, in the alignment list's summary form, with a running rebuild's state", async () => {
  const two = await bothReads(OWNER_TOKEN, "w-two");
  assert.deepEqual(
    two.readingSync.map((entry) => [entry.recordingId, entry.ebookId, entry.id]),
    [
      ["rec-two-a", "eb-two", "job-ready"],
      ["rec-two-a", "eb-two-held", "job-projected"],
      ["rec-two-b", "eb-two", "job-rebuild"],
    ],
    "one per pair of recording and edition that has a job, by recording, then edition",
  );
  const [ready, projected, rebuilding] = two.readingSync;
  assert.equal(projected.origin, "projected");
  assert.equal(ready.status, "ready");
  assert.equal(ready.intervalCount, 2);
  assert.equal(ready.rebuild, undefined);
  // The rebuild runs: the pair serves its published map and shows the rebuild's state.
  assert.equal(rebuilding.status, "ready");
  assert.equal(rebuilding.engine, "ctc-wav2vec2-base-960h-torchaudio-2.8-v2");
  assert.deepEqual(rebuilding.rebuild, {
    status: "processing",
    progress: 0.3,
    engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2",
    error: null,
    updatedAt: T0,
  });
  // Each entry is the alignment list's summary of that job without steps, workers and stage times.
  const list = await alignmentList(OWNER_TOKEN);
  for (const entry of two.readingSync) {
    const listed = list.find((j) => j.id === entry.id);
    assert.ok(listed, entry.id);
    for (const key of omitted) assert.equal(key in entry, false, `${key} stays on the alignment routes`);
    assert.ok("pool" in listed && "stageTimings" in listed && "anchoring" in listed, "the alignment list still has them");
    // The list's `rebuild` also carries the new job's run, steps and result for the Reading sync page (#538): the
    // work lists its state only.
    const summary = Object.fromEntries(Object.entries(listed).filter(([key]) => !omitted.includes(key)));
    if (listed.rebuild) {
      const { generation: _g, bookJob: _b, poolErrors: _p, coverage: _c, elapsedSeconds: _e, createdAt: _a, ...state } = listed.rebuild;
      summary.rebuild = state;
    }
    assert.deepEqual(entry, summary, `${entry.id} is the list's summary`);
  }
  // Sam has only ed-two-a (rec-two-a): only that pair.
  const samTwo = await bothReads(SAM_TOKEN, "w-two");
  assert.deepEqual(samTwo.readingSync.map((entry) => entry.id), ["job-ready", "job-projected"]);
  // A work outside the library has no recordings, so no pair.
  assert.deepEqual((await work(OWNER_TOKEN, "w-outside")).readingSync, []);
});

test("series: every series of the work, the saved one first, then in Hardcover's order", async () => {
  const owner = await bothReads(OWNER_TOKEN, "w-two");
  assert.deepEqual(owner.series, [
    { id: 88, name: "Wider World", position: 4.5, saved: true },
    { id: 77, name: "Pair Saga", position: 1, saved: false },
    { id: null, name: "Unnumbered Cycle", position: null, saved: false },
  ]);
  // Sam saved none: Hardcover's order, nothing saved.
  assert.deepEqual((await bothReads(SAM_TOKEN, "w-two")).series, [
    { id: 77, name: "Pair Saga", position: 1, saved: false },
    { id: 88, name: "Wider World", position: 4.5, saved: false },
    { id: null, name: "Unnumbered Cycle", position: null, saved: false },
  ]);
  assert.deepEqual((await bothReads(OWNER_TOKEN, "w-unplayed")).series, [], "a work without a Hardcover book has none");
});

test("media state: queued with the acquisition's progress, failed with its error, held with its reason", async () => {
  const queued = await bothReads(OWNER_TOKEN, "w-queued");
  assert.deepEqual(queued.mediaState, {
    state: "queued",
    holdReason: null,
    acquisition: { id: "acq-queued", status: "downloading", progress: 0.42, error: null },
  });
  const failed = await bothReads(OWNER_TOKEN, "w-failed");
  assert.deepEqual(failed.mediaState, {
    state: "failed",
    holdReason: null,
    acquisition: { id: "acq-failed", status: "error", progress: 0.1, error: failure },
  });
  const held = await bothReads(OWNER_TOKEN, "w-only");
  assert.deepEqual(held.mediaState, { state: "missing", holdReason: "unreleased", acquisition: null });
  // State, hold reason and acquisition id are what the book list gives each user.
  const books = (await get("/api/books", OWNER_TOKEN)).json() as Book[];
  for (const w of [queued, failed, held]) {
    const entry = books.find((b) => b.workId === w.workId && b.inLibrary);
    assert.deepEqual(entry?.mediaState, {
      state: w.mediaState?.state,
      holdReason: w.mediaState?.holdReason,
      acquisitionId: w.mediaState?.acquisition?.id ?? null,
      updatedAt: entry?.mediaState && (entry.mediaState as { updatedAt?: number }).updatedAt,
    });
  }
  assert.equal((await bothReads(OWNER_TOKEN, "w-two")).mediaState, null, "a work without a media state");
});

test("an acquisition's status, progress and error are the administrator's", async () => {
  assert.equal((await get("/api/acquisitions", SAM_TOKEN)).statusCode, 403);
  assert.equal((await get("/api/activity", SAM_TOKEN)).statusCode, 403);
  const queued = await bothReads(SAM_TOKEN, "w-queued");
  assert.deepEqual(queued.mediaState, {
    state: "queued",
    holdReason: null,
    acquisition: { id: "acq-queued", status: null, progress: null, error: null },
  });
  const failed = await bothReads(SAM_TOKEN, "w-failed");
  assert.deepEqual(failed.mediaState, {
    state: "failed",
    holdReason: null,
    acquisition: { id: "acq-failed", status: null, progress: null, error: null },
  });
  for (const url of ["/api/library", "/api/works/w-failed", "/api/works/w-queued"]) {
    const body = (await get(url, SAM_TOKEN)).body;
    assert.ok(!body.includes("/srv/torrents") && !body.includes("downloading"), url);
  }
  // Sam's tag does not follow the acquisition; the administrator's does.
  const samTag = String((await get("/api/library", SAM_TOKEN)).headers.etag);
  const ownerTag = String((await get("/api/library", OWNER_TOKEN)).headers.etag);
  acquisition("acq-queued", "w-queued", "downloading", 0.57, null, [OWNER, SAM]);
  try {
    assert.equal((await get("/api/library", SAM_TOKEN, { "if-none-match": samTag })).statusCode, 304);
    const owner = await get("/api/library", OWNER_TOKEN, { "if-none-match": ownerTag });
    assert.equal(owner.statusCode, 200);
    assert.equal(
      (owner.json() as LibraryWork[]).find((w) => w.workId === "w-queued")?.mediaState?.acquisition?.progress,
      0.57,
    );
  } finally {
    acquisition("acq-queued", "w-queued", "downloading", 0.42, null, [OWNER, SAM]);
  }
});

test("finished by a recording's end, by an ebook edition's end and by the override in both directions", async () => {
  const finished = async (workId: string, token = OWNER_TOKEN) => {
    const w = await bothReads(token, workId);
    return { finished: w.finished, completionOverride: w.completionOverride };
  };
  const completion = async (workId: string, status: "finished" | "unread" | "derived") => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/works/${workId}/completion`,
      payload: { status },
      cookies: { sonder_session: OWNER_TOKEN },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  // A recording's end: the owner's place at the end of rec-unplayed-a's only track.
  assert.deepEqual(await finished("w-unplayed"), { finished: false, completionOverride: null });
  run("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,?,?,?,?,?)",
    OWNER, "rec-unplayed-a", "t-unplayed-a-0", 600, 600, T0 + 20 * DAY);
  assert.deepEqual(await finished("w-unplayed"), { finished: true, completionOverride: null });
  // An ebook edition's end, read while reading; the end reached while listening does not count.
  checkpoint(OWNER, "eb-epub", 1, "listening", T0 + 21 * DAY);
  assert.deepEqual(await finished("w-epub"), { finished: false, completionOverride: null });
  checkpoint(OWNER, "eb-epub", 1, "reading", T0 + 22 * DAY);
  assert.deepEqual(await finished("w-epub"), { finished: true, completionOverride: null });
  // The override, both ways, and back to the derived state.
  await completion("w-unplayed", "unread");
  assert.deepEqual(await finished("w-unplayed"), { finished: false, completionOverride: "unread" });
  await completion("w-two", "finished");
  assert.deepEqual(await finished("w-two"), { finished: true, completionOverride: "finished" });
  await completion("w-unplayed", "derived");
  assert.deepEqual(await finished("w-unplayed"), { finished: true, completionOverride: null });
  // Marked finished in the library (as the book list's status) also counts.
  assert.deepEqual(await finished("w-beside"), { finished: false, completionOverride: null });
  run("UPDATE user_library SET status='finished' WHERE user_id=? AND book_id='ed-beside'", OWNER);
  assert.deepEqual(await finished("w-beside"), { finished: true, completionOverride: null });
});

test("a second user's places, overrides and saved series are not visible", async () => {
  // The owner's place in eb-epub, override on w-two and saved series 88 (tests above set or keep them).
  checkpoint(OWNER, "eb-epub", 0.4, "reading", T0 + 15 * DAY);
  run(
    "INSERT INTO user_work_completion(user_id,work_id,status) VALUES(?,'w-two','finished') ON CONFLICT DO UPDATE SET status='finished'",
    OWNER,
  );
  // w-epub's only audio edition is a placeholder Sam may not see, but it has ebook editions, which
  // every user is shown (`GET /api/ebooks`), so Sam sees the work (#573: the rule `GET /api/works`
  // shares with this read). Sam has it in the library too below.
  assert.equal((await get("/api/works/w-epub", SAM_TOKEN)).statusCode, 200);
  run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,'hc-201','unread',?)", SAM, T0 + 25 * DAY);
  const samEpub = await bothReads(SAM_TOKEN, "w-epub");
  assert.deepEqual(samEpub.ebooks.map((e) => e.id), ["eb-epub", "eb-pdf"]);
  assert.deepEqual(samEpub.ebooks.map((e) => e.place), [null, null], "the owner's place is not Sam's");
  const samTwo = await bothReads(SAM_TOKEN, "w-two");
  assert.deepEqual({ finished: samTwo.finished, completionOverride: samTwo.completionOverride }, {
    finished: false,
    completionOverride: null,
  });
  assert.ok(samTwo.series.every((entry) => !entry.saved));
  assert.equal(samTwo.hardcover?.statusId, 1, "Sam's own Hardcover shelf");
  assert.deepEqual(samTwo.hardcover?.listIds, [], "the owner's lists are not Sam's");
  // The owner's queued Hardcover status and progress and last read are the owner's.
  run("INSERT INTO user_hardcover_outbox(user_id,book_id,account_id,status_id,updated_at,error) VALUES(?,9001,1,4,?,'Rate limited')", OWNER, T0);
  run(
    "INSERT INTO user_hardcover_progress(user_id,book_id,account_id,recording_id,position,duration,updated_at) VALUES(?,9001,1,'rec-two-a',300,600,?)",
    OWNER,
    T0,
  );
  run("INSERT INTO user_hardcover_reads(user_id,book_id,account_id,snapshot,fraction,synced_at) VALUES(?,9001,1,'{}',0.9,?)", OWNER, T0);
  try {
    const ownHardcover = (await bothReads(OWNER_TOKEN, "w-two")).hardcover;
    assert.deepEqual(
      [ownHardcover?.statusId, ownHardcover?.pending, ownHardcover?.progressFraction, ownHardcover?.progressPending, ownHardcover?.syncError],
      [4, true, 0.5, true, "Rate limited"],
    );
    const samHardcover = (await bothReads(SAM_TOKEN, "w-two")).hardcover;
    assert.deepEqual(
      [samHardcover?.statusId, samHardcover?.pending, samHardcover?.progressFraction, samHardcover?.progressPending, samHardcover?.syncError],
      [1, false, null, false, null],
    );
    run("DELETE FROM user_hardcover_progress WHERE user_id=?", OWNER);
    assert.equal((await bothReads(OWNER_TOKEN, "w-two")).hardcover?.progressFraction, 0.9, "the owner's last read");
    assert.equal((await bothReads(SAM_TOKEN, "w-two")).hardcover?.progressFraction, null);
  } finally {
    run("DELETE FROM user_hardcover_outbox WHERE user_id=?", OWNER);
    run("DELETE FROM user_hardcover_progress WHERE user_id=?", OWNER);
    run("DELETE FROM user_hardcover_reads WHERE user_id=?", OWNER);
  }
  // Sam's own place shows to Sam only.
  checkpoint(SAM, "eb-two", 0.25, "reading", T0 + 23 * DAY);
  assert.deepEqual((await bothReads(SAM_TOKEN, "w-two")).ebooks[0].place, {
    progression: 0.25,
    origin: "reading",
    updatedAt: T0 + 23 * DAY,
  });
  assert.equal((await bothReads(OWNER_TOKEN, "w-two")).ebooks[0].place, null);
  // The failed acquisition is the owner's and Sam's; a work with only the owner's media state is not Sam's.
  placeholderWork("w-owner-hold", "hc-204", [OWNER, SAM], T0 + 19 * DAY);
  run(
    "INSERT INTO work_media_states(user_id,work_id,state,hold_reason,acquisition_id,updated_at) VALUES(?,?,'missing','empty_search',NULL,?)",
    OWNER,
    "w-owner-hold",
    T0,
  );
  assert.deepEqual((await bothReads(OWNER_TOKEN, "w-owner-hold")).mediaState, {
    state: "missing",
    holdReason: "empty_search",
    acquisition: null,
  });
  assert.equal((await bothReads(SAM_TOKEN, "w-owner-hold")).mediaState, null);
});

test("the Hardcover block equals the book list's for the same work", async () => {
  for (const token of [OWNER_TOKEN, SAM_TOKEN]) {
    const books = (await get("/api/books", token)).json() as Book[];
    const entry = books.find((b) => b.workId === "w-two");
    assert.ok(entry?.hardcover, "the book list has a Hardcover block for w-two");
    assert.deepEqual((await bothReads(token, "w-two")).hardcover, entry.hardcover);
    assert.equal(books.find((b) => b.workId === "w-unplayed")?.hardcover, undefined);
    assert.equal((await work(token, "w-unplayed")).hardcover, null);
  }
  const owner = await work(OWNER_TOKEN, "w-two");
  assert.equal(owner.hardcover?.statusId, 3);
  assert.deepEqual(owner.hardcover?.listIds, [5]);
});

/** Library tag before and after `change`; the change must give a new tag (200), and `check` sees the new body. */
async function tagFollows(token: string, why: string, change: () => unknown, check?: (works: LibraryWork[]) => void) {
  const tag = String((await get("/api/library", token)).headers.etag);
  assert.equal((await get("/api/library", token, { "if-none-match": tag })).statusCode, 304, `${why}: unchanged first`);
  await change();
  const after = await get("/api/library", token, { "if-none-match": tag });
  assert.equal(after.statusCode, 200, `${why}: the tag follows`);
  assert.notEqual(String(after.headers.etag), tag, why);
  check?.(after.json() as LibraryWork[]);
}
const inWork = (works: LibraryWork[], workId: string) => {
  const found = works.find((w) => w.workId === workId);
  assert.ok(found, workId);
  return found;
};

test("the entity tag follows each part a work holds", async () => {
  await tagFollows(OWNER_TOKEN, "an ebook place", () => checkpoint(OWNER, "eb-epub", 0.6, "reading", T0 + 24 * DAY), (works) =>
    assert.equal(inWork(works, "w-epub").ebooks[0].place?.progression, 0.6));
  await tagFollows(OWNER_TOKEN, "a new ebook edition", () => ebook("eb-epub-2", "w-epub", "epub", "second"), (works) =>
    assert.deepEqual(inWork(works, "w-epub").ebooks.map((e) => e.id), ["eb-epub", "eb-pdf", "eb-epub-2"]));
  await tagFollows(OWNER_TOKEN, "a member's check", () => member("w-two", "eb-two-held", "accepted", null), (works) =>
    assert.deepEqual(inWork(works, "w-two").ebooks[1].check, { status: "accepted", holdReason: null }));
  await tagFollows(OWNER_TOKEN, "the shared default", () => run("UPDATE work_ebook_set SET default_ebook_id='eb-two-held' WHERE work_id='w-two'"),
    (works) => assert.equal(inWork(works, "w-two").chosenEbookId, "eb-two-held"));
  await tagFollows(
    OWNER_TOKEN,
    "a rebuild's progress",
    () =>
      job(
        alignment("job-rebuild", "eb-two", "rec-two-b", "processing", 0.8),
        T0 + 6,
        alignment("job-rebuild", "eb-two", "rec-two-b", "ready", 1, { engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v2" }),
      ),
    (works) => assert.equal(inWork(works, "w-two").readingSync[2].rebuild?.progress, 0.8),
  );
  await tagFollows(
    OWNER_TOKEN,
    "a rebuild that published",
    () => job(alignment("job-rebuild", "eb-two", "rec-two-b", "ready", 1), T0 + 7),
    (works) => {
      const entry = inWork(works, "w-two").readingSync[2];
      assert.equal(entry.rebuild, undefined);
      assert.equal(entry.engine, "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2");
    },
  );
  await tagFollows(OWNER_TOKEN, "a saved series", () => run("INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(?,77,?)", OWNER, T0),
    (works) => assert.deepEqual(inWork(works, "w-two").series.map((e) => [e.id, e.saved]), [[77, true], [88, true], [null, false]]));
  await tagFollows(OWNER_TOKEN, "a hold reason", () => run("UPDATE work_media_states SET hold_reason='empty_search' WHERE user_id=? AND work_id='w-only'", OWNER),
    (works) => assert.equal(inWork(works, "w-only").mediaState?.holdReason, "empty_search"));
  await tagFollows(OWNER_TOKEN, "an acquisition's error", () => acquisition("acq-failed", "w-failed", "error", 0.1, "Another reason", [OWNER]),
    (works) => assert.equal(inWork(works, "w-failed").mediaState?.acquisition?.error, "Another reason"));
  await tagFollows(
    OWNER_TOKEN,
    "an override",
    () =>
      run(
        "INSERT INTO user_work_completion(user_id,work_id,status) VALUES(?,'w-two','unread') ON CONFLICT DO UPDATE SET status='unread'",
        OWNER,
      ),
    (works) => assert.equal(inWork(works, "w-two").completionOverride, "unread"),
  );
  await tagFollows(OWNER_TOKEN, "a Hardcover shelf", () => run("UPDATE user_hardcover_links SET status_id=2 WHERE user_id=? AND book_id=9001", OWNER),
    (works) => assert.equal(inWork(works, "w-two").hardcover?.statusId, 2));
});

test("an ebook file removed or added outside the server shows within the file checks' time to live", async () => {
  const tag = String((await get("/api/library", OWNER_TOKEN)).headers.etag);
  unlinkSync(epubSource);
  try {
    assert.equal((await get("/api/library", OWNER_TOKEN, { "if-none-match": tag })).statusCode, 304, "remembered for the time to live");
    clock += filePresence.ttlMs;
    const gone = await get("/api/library", OWNER_TOKEN, { "if-none-match": tag });
    assert.equal(gone.statusCode, 200);
    assert.deepEqual(
      (({ size, available }) => ({ size, available }))(inWork(gone.json() as LibraryWork[], "w-epub").ebooks[0]),
      { size: 0, available: false },
    );
  } finally {
    writeFileSync(epubSource, "epub bytes, longer");
  }
  clock += filePresence.ttlMs;
  const back = await get("/api/library", OWNER_TOKEN);
  assert.deepEqual(
    (({ size, available }) => ({ size, available }))(inWork(back.json() as LibraryWork[], "w-epub").ebooks[0]),
    { size: "epub bytes, longer".length, available: true },
  );
  // A size change alone shows too.
  const backTag = String(back.headers.etag);
  writeFileSync(epubSource, "epub");
  clock += filePresence.ttlMs;
  const resized = await get("/api/library", OWNER_TOKEN, { "if-none-match": backTag });
  assert.equal(resized.statusCode, 200);
  assert.equal(inWork(resized.json() as LibraryWork[], "w-epub").ebooks[0].size, 4);
});

test("a reading sync job changed right after a read shows at the next read", async () => {
  const { putAlignmentJob } = await import("../server/alignment-transitions.ts");
  const progressOf = async () =>
    inWork(await library(OWNER_TOKEN), "w-two").readingSync.find((entry) => entry.id === "job-ready")?.progress;
  const realNow = Date.now;
  try {
    // Through the server's writer, which stamps the time of each write: back to back, within a millisecond or two.
    const written = alignment("job-ready", "eb-two", "rec-two-a", "processing", 0.5) as unknown as Parameters<typeof putAlignmentJob>[0];
    for (const progress of [0.5, 0.6, 0.7]) {
      putAlignmentJob({ ...written, progress });
      assert.equal(await progressOf(), progress, "each write shows at the next read");
    }
    // A row read in the millisecond of its last write is read again next time, even when a second
    // write in that millisecond kept its length.
    const now = realNow();
    Date.now = () => now;
    job(alignment("job-ready", "eb-two", "rec-two-a", "processing", 0.31), now);
    assert.equal(await progressOf(), 0.31);
    job(alignment("job-ready", "eb-two", "rec-two-a", "processing", 0.32), now);
    assert.equal(await progressOf(), 0.32, "same time, same length");
    Date.now = realNow;
    // A row read after its write: a change of its length or of its kept map shows, also with the same time.
    job(alignment("job-ready", "eb-two", "rec-two-a", "processing", 0.4), now - 10);
    assert.equal(await progressOf(), 0.4);
    job(alignment("job-ready", "eb-two", "rec-two-a", "processing", 0.45), now - 10);
    assert.equal(await progressOf(), 0.45, "same time, another length");
    job(alignment("job-ready", "eb-two", "rec-two-a", "processing", 0.45), now - 10, alignment("job-ready", "eb-two", "rec-two-a", "ready", 1));
    const kept = inWork(await library(OWNER_TOKEN), "w-two").readingSync.find((entry) => entry.id === "job-ready");
    assert.equal(kept?.status, "ready", "the kept map is served");
    assert.equal(kept?.rebuild?.progress, 0.45, "with the rebuild's state");
  } finally {
    Date.now = realNow;
    job(alignment("job-ready", "eb-two", "rec-two-a", "ready", 1), T0 + 1);
  }
});
