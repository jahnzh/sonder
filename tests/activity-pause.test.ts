import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-pause-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.SONDER_DOWNLOAD_RETRY_MS = "1,1,1";
delete process.env.SONDER_SKIP_SERIES_ACQUISITION;
const realFetch = globalThis.fetch;
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const pause = await import("../server/activity-pause.ts");
const { seriesAcquisitionTickerEnabled } = await import("../server/series-acquisition.ts");
const { processServerDownloads } = await import("../server/downloads.ts");
const { refreshQueue } = await import("../server/acquisitions.ts");
const { tickHardcover, setHardcoverToken } = await import("../server/hardcover.ts");
const { setUserSetting } = await import("../server/users.ts");
const { processAlignments, alignmentJob } = await import("../server/alignment.ts");
const app = await createApp();
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  rmSync(temp, { recursive: true, force: true });
});

const status = (table: string, column: string, id: string) =>
  (sqlite.prepare(`SELECT status FROM ${table} WHERE ${column} = ?`).get(id) as { status: string }).status;

test("a pause switch is stored, survives reading it again, and an environment flag locks it", () => {
  assert.equal(pause.isPaused("alignment"), false);
  pause.setPaused("alignment", true);
  assert.equal(pause.isPaused("alignment"), true);
  assert.equal((sqlite.prepare("SELECT value FROM settings WHERE key = 'activityPaused:alignment'").get() as any).value, "1");
  assert.deepEqual(pause.pauseState().alignment, { paused: true, locked: false });
  pause.setPaused("alignment", false);
  assert.equal(pause.isPaused("alignment"), false);
  assert.equal(sqlite.prepare("SELECT 1 FROM settings WHERE key = 'activityPaused:alignment'").get(), undefined);

  assert.equal(seriesAcquisitionTickerEnabled(), true);
  pause.setPaused("series-acquisition", true);
  assert.equal(seriesAcquisitionTickerEnabled(), false, "the series loop honours the switch");
  pause.setPaused("series-acquisition", false);
  process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
  assert.equal(seriesAcquisitionTickerEnabled(), false, "and the environment flag");
  assert.deepEqual(pause.pauseState()["series-acquisition"], { paused: false, locked: true });
  delete process.env.SONDER_SKIP_SERIES_ACQUISITION;
  assert.equal(seriesAcquisitionTickerEnabled(), true);
  assert.equal(pause.isPausable("alignment"), true);
  assert.equal(pause.isPausable("torrent-client"), false);
});

test("a paused download queue is not checked or imported", async () => {
  sqlite.prepare("INSERT INTO acquisitions(id,hash,backend,title,author,cover,status,created_at,updated_at,magnet) VALUES('stale','h','local','Stale','A','','checking',?,?,'magnet:?xt=urn:btih:h')")
    .run(Date.now() - 600_000, Date.now() - 600_000);
  pause.setPaused("acquisitions", true);
  await refreshQueue();
  assert.equal(status("acquisitions", "id", "stale"), "checking", "paused: nothing is touched");
  pause.setPaused("acquisitions", false);
  await refreshQueue();
  assert.equal(status("acquisitions", "id", "stale"), "error", "resumed: the stale check is handled");
});

test("a paused copy queue starts nothing, and pausing during a copy lets it finish and holds the next", async () => {
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('wp','Pause book','A','','',2000)").run();
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('edp','wp','','',0,'')").run();
  for (const id of ["ra", "rb"]) {
    sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,'edp')").run(id);
    sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,0,60,?,'remote','[]')")
      .run(`t-${id}`, id, id, `http://audio.test/${id}.mp3`);
    sqlite.prepare("INSERT INTO server_downloads(recording_id,book_id,status,progress,created_at,updated_at) VALUES(?,'edp','queued',0,?,?)").run(id, Date.now(), Date.now());
  }
  pause.setPaused("server-copies", true);
  await processServerDownloads();
  assert.equal(status("server_downloads", "recording_id", "ra"), "queued");
  assert.equal(status("server_downloads", "recording_id", "rb"), "queued");

  pause.setPaused("server-copies", false);
  const fetched: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    if (!String(input).startsWith("http://audio.test/")) return realFetch(input, init);
    fetched.push(String(input));
    pause.setPaused("server-copies", true); // the owner pauses while the first copy is running
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  await processServerDownloads();
  globalThis.fetch = realFetch;
  assert.ok(fetched.length > 0, "the running copy was attempted");
  assert.ok(
    fetched.every((url) => url === "http://audio.test/ra.mp3"),
    "only the copy that was already running ran (its file is retried)",
  );
  assert.equal(status("server_downloads", "recording_id", "ra"), "error", "the running copy finished (here: failed on its own)");
  assert.equal(status("server_downloads", "recording_id", "rb"), "queued", "the next copy waits");
  pause.setPaused("server-copies", false);
});

test("a paused Hardcover sync sends nothing until resumed", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    if (!String(input).startsWith("https://api.hardcover.app/")) return realFetch(input, init);
    calls.push(String(init?.body ?? "").slice(0, 40));
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  setHardcoverToken(1, "key-a");
  setUserSetting(1, "hardcoverState", JSON.stringify({ mode: "two-way" }));
  pause.setPaused("hardcover-sync", true);
  await tickHardcover();
  assert.equal(calls.length, 0, "paused: no request");
  pause.setPaused("hardcover-sync", false);
  await tickHardcover();
  assert.ok(calls.length > 0, "resumed: the sync runs");
  globalThis.fetch = realFetch;
});

test("a paused alignment processor starts no job; resumed, it picks the job up", async () => {
  process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
  try {
    sqlite.prepare("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('eb-missing','wp','epub',?)").run(join(temp, "no-such-book.epub"));
    const now = Date.now();
    sqlite.prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES('job-pause','eb-missing','ra',?,?)").run(
      JSON.stringify({
        id: "job-pause", generation: "g1", ebookId: "eb-missing", recordingId: "ra", status: "queued", progress: 0,
        engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v2", error: null, warning: null, intervals: [], sectionsDone: [],
        elapsedSeconds: 0, fingerprint: "", audioFingerprint: "", updatedAt: now, createdAt: now, coverage: 0, pairings: [],
      }),
      now,
    );
    pause.setPaused("alignment", true);
    await processAlignments();
    assert.equal(alignmentJob("job-pause").status, "queued", "paused: the job is not started");
    pause.setPaused("alignment", false);
    await processAlignments();
    assert.equal(alignmentJob("job-pause").status, "error", "resumed: the processor picks it up (here: fails on the missing book)");
  } finally {
    delete process.env.ALIGNMENT_WORKER_TOKEN;
  }
});
