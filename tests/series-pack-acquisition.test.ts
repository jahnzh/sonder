// Series packs end to end on the server (ADR 0027, #899): the queue takes a pack that covers two or more waiting
// books over their own searches (never a book that has audio, never a book the pack does not cover), each book gets
// its own recording of only its files, a book the split is not sure of waits for the owner's choice, a book wanted
// later shares the pack without a second download, the Get sheet's describe names the pack's books, and removing a
// book keeps the pack's files while another book uses them. TorBox is a fixture that has every torrent cached; the
// local pack's files are real WAV files under MEDIA_ROOT. No live request is made.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-pack-acquisition-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { and, eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { enqueueSeriesAcquisition, tickSeriesAcquisition, setSeriesAcquisitionDeps, resetSeriesAcquisitionDeps } = await import(
  "../server/series-acquisition.ts"
);
const { getWorkMediaState } = await import("../server/work-media-state.ts");
const { packEditionId, recordPack, importPack } = await import("../server/acquisition-packs.ts");
const { purgeEditionForTests, removeSavedSeries } = await import("../server/series-removal.ts");
const { describePack, packRequestFor } = await import("../server/series-pack-step.ts");
const { acquireReplacing } = await import("../server/acquisitions.ts");
const { completedDir } = await import("../server/storage.ts");

const app = await createApp({ background: { manual: true } });

const SERIES = "sr-pack-saga";
const PACK_HASH = "a".repeat(40);
const FIFTH_HASH = "b".repeat(40);
const magnet = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
const TITLES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
const work = (n: number) => `w-pack-${n}`;

// TorBox: every torrent cached; the pack holds books 1 to 3 by folder, book 4 under a name the split cannot read.
const created: string[] = [];
const torrents = new Map<number, string>();
const TORBOX_FILES: Record<string, { id: number; name: string }[]> = {
  [PACK_HASH]: [
    { id: 10, name: "Pack Saga 1-4/Book 1 - Alpha/01.mp3" },
    { id: 11, name: "Pack Saga 1-4/Book 1 - Alpha/02.mp3" },
    { id: 20, name: "Pack Saga 1-4/Book 2 - Beta/beta.m4b" },
    { id: 30, name: "Pack Saga 1-4/Book 3 - Gamma/gamma.m4b" },
    { id: 40, name: "Pack Saga 1-4/Extras/fourth.m4b" },
    { id: 50, name: "Pack Saga 1-4/cover.jpg" },
  ],
  [FIFTH_HASH]: [{ id: 1, name: "Epsilon/epsilon.m4b" }],
  ["e".repeat(40)]: [
    { id: 1, name: "Get Saga Books 1-3/Get Saga 01.m4b" },
    { id: 2, name: "Get Saga Books 1-3/Get Saga 02.m4b" },
    { id: 3, name: "Get Saga Books 1-3/Get Saga 03.m4b" },
  ],
};
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.torbox.app") throw new Error(`Unexpected external request: ${url}`);
  let data: unknown;
  if (url.pathname.endsWith("checkcached")) data = [{ hash: url.searchParams.get("hash") }];
  else if (url.pathname.endsWith("createtorrent")) {
    const hash = /btih:([a-f0-9]{40})/.exec(String((init?.body as FormData).get("magnet")))![1];
    created.push(hash);
    const id = 100 + torrents.size;
    torrents.set(id, hash);
    data = { torrent_id: id };
  } else if (url.pathname.endsWith("mylist")) data = { download_present: true, files: TORBOX_FILES[torrents.get(Number(url.searchParams.get("id")))!] };
  else throw new Error(`Unexpected TorBox request: ${url}`);
  return Response.json({ success: true, data });
};
db.insert(s.settings).values({ key: "torbox", value: encrypt("pack-key") }).run();

const searched: string[] = [];
const seriesAudioDeps = {
  abbSearch: async (q: string) => {
    searched.push(q);
    return {
      results: [
        { id: "saga-pack", title: "Pack Saga Books 1-4 [M4B]", format: "M4B", language: "English" },
        { id: "saga-pack-fr", title: "Pack Saga Livres 1-4", format: "M4B", language: "French" },
        { id: "saga-5", title: "Pack Saga Book 5 Epsilon", format: "M4B", language: "English", narrator: "Reader" },
      ],
      page: 1,
      nextPage: null,
    };
  },
  prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
  abbMagnetLink: async (id: string) => (id === "saga-5" ? magnet(FIFTH_HASH, "Fifth") : id === "saga-pack-fr" ? magnet("c".repeat(40), "FR") : magnet(PACK_HASH, "Pack")),
  prowlarrMagnetLink: async () => "",
  cachedHashes: async (hashes: string[]) => new Set(hashes),
  log: () => {},
};

function seedSeries(series: string, name: string, count: number, prefix: (n: number) => string) {
  sqlite.prepare("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(?,?,?,?)").run(series, name, "Ada Author", count);
  sqlite.prepare("INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,?,?)").run(series, Date.now());
  for (let n = 1; n <= count; n++) {
    db.insert(s.works).values({ id: prefix(n), title: TITLES[n - 1], author: "Ada Author", description: "", genre: "", year: 2020 }).run();
    sqlite
      .prepare("INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased,language) VALUES(?,?,?,?,?,?,0,'English')")
      .run(series, `${series}-bk-${n}`, prefix(n), TITLES[n - 1], n, `https://covers.test/${n}.jpg`);
    sqlite.prepare("INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(1,?,?,?,1)").run(series, `${series}-bk-${n}`, prefix(n));
  }
}
seedSeries(SERIES, "Pack Saga", 5, work);

/** Book 2 already has its own audio: the pack must not replace it. */
function giveOwnAudio(workId: string) {
  db.insert(s.editions).values({ id: "own-beta", workId, cover: "", narrator: "N", rating: 0, sourceLabel: "Local" }).run();
  db.insert(s.recordings).values({ id: "rec-own-beta", editionId: "own-beta" }).run();
  db.insert(s.tracks).values({ id: "t-own-beta", recordingId: "rec-own-beta", title: "c", index: 0, duration: 1, source: "/dev/null", sourceType: "local" }).run();
}
giveOwnAudio(work(2));

beforeEach(() => {
  resetSeriesAcquisitionDeps();
  setSeriesAcquisitionDeps({ seriesAudioDeps, canAcquireMedia: () => true });
});

after(async () => {
  globalThis.fetch = original;
  resetSeriesAcquisitionDeps();
  await app.close();
  sqlite.close();
});

const acquisitionOf = (hash: string) => db.select().from(s.acquisitions).where(eq(s.acquisitions.hash, hash)).get();
const packRow = (acquisitionId: string, workId: string) =>
  db.select().from(s.acquisitionWorks).where(and(eq(s.acquisitionWorks.acquisitionId, acquisitionId), eq(s.acquisitionWorks.workId, workId))).get();
function tracksOf(editionId: string) {
  return db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.recordingId, `recording-${editionId}`))
    .all()
    .sort((a, b) => a.index - b.index);
}
const fileIds = (editionId: string) => tracksOf(editionId).map((track) => (JSON.parse(track.source) as { fileId: number }).fileId);
const jobOf = (workId: string) =>
  db.select().from(s.seriesAcquisitionJobs).where(and(eq(s.seriesAcquisitionJobs.workId, workId), eq(s.seriesAcquisitionJobs.kind, "audio"))).get();

test("the queue takes one pack for the waiting books it covers; each gets its own recording of only its files", async () => {
  enqueueSeriesAcquisition(
    1,
    SERIES,
    [1, 2, 3, 4, 5].map((n) => ({ bookId: `${SERIES}-bk-${n}`, workId: work(n), unreleased: false })),
    { searchAudio: true },
  );
  await tickSeriesAcquisition();

  // One download for the pack (the French one never), one for the book it does not cover.
  assert.deepEqual(created.sort(), [PACK_HASH, FIFTH_HASH].sort());
  const pack = acquisitionOf(PACK_HASH)!;
  assert.equal(pack.status, "ready", pack.error ?? "");
  assert.equal(pack.title, "Pack Saga Books 1-4 [M4B]");
  // Book 2 had audio: it is not in the pack, and its own recording stays.
  const rows = db.select().from(s.acquisitionWorks).where(eq(s.acquisitionWorks.acquisitionId, pack.id)).all();
  assert.deepEqual(rows.map((row) => row.workId).sort(), [work(1), work(3), work(4)]);
  assert.ok(db.select().from(s.editions).where(eq(s.editions.id, "own-beta")).get());

  // Each book: its own edition and recording, holding only its files, in order; never the cover or another book's.
  assert.deepEqual(fileIds(packEditionId(pack, work(1))), [10, 11]);
  assert.deepEqual(fileIds(packEditionId(pack, work(3))), [30]);
  assert.equal(packRow(pack.id, work(1))?.status, "ready");
  assert.equal(db.select().from(s.editions).where(eq(s.editions.id, packEditionId(pack, work(3)))).get()?.cover, "https://covers.test/3.jpg");
  assert.equal(getWorkMediaState(1, work(1))?.state, "available");
  assert.equal(getWorkMediaState(1, work(3))?.state, "available");
  // Book 4's files could not be told: no recording, waiting for the owner's choice.
  assert.equal(packRow(pack.id, work(4))?.status, "choose");
  assert.equal(getWorkMediaState(1, work(4))?.state, "missing");
  // The pack's other books needed no search of their own; book 5 had its own.
  assert.equal(jobOf(work(3))?.status, "done");
  assert.equal(jobOf(work(4))?.status, "done");
  assert.equal(getWorkMediaState(1, work(5))?.state, "available");
  assert.equal(acquisitionOf(FIFTH_HASH)?.workId, work(5));
  // Each book's recording is in the library.
  for (const n of [1, 3]) assert.ok(db.select().from(s.userLibrary).where(eq(s.userLibrary.bookId, packEditionId(pack, work(n)))).get());
});

test("a pack on its way shows each of its books as queued", () => {
  const pack = acquisitionOf(PACK_HASH)!;
  db.update(s.acquisitions).set({ status: "downloading" }).where(eq(s.acquisitions.id, pack.id)).run();
  try {
    assert.equal(getWorkMediaState(1, work(4))?.state, "queued");
    assert.equal(getWorkMediaState(1, work(4))?.acquisitionId, pack.id);
  } finally {
    db.update(s.acquisitions).set({ status: "ready" }).where(eq(s.acquisitions.id, pack.id)).run();
  }
});

test("the owner chooses the files of a book the split was not sure of", async () => {
  const pack = acquisitionOf(PACK_HASH)!;
  const listed = await app.inject({ method: "GET", url: `/api/works/${work(4)}/pack` });
  assert.equal(listed.statusCode, 200, listed.body);
  const [choice] = listed.json().choices as { acquisitionId: string; title: string; units: { key: string; label: string; files: number; position: number | null }[] }[];
  assert.equal(choice.acquisitionId, pack.id);
  assert.deepEqual(choice.units.map((unit) => [unit.label, unit.position]), [["Book 1 - Alpha", 1], ["Book 2 - Beta", 2], ["Book 3 - Gamma", 3], ["Extras", null]]);
  const extras = choice.units.find((unit) => unit.label === "Extras")!;

  const refused = await app.inject({ method: "POST", url: `/api/works/${work(4)}/pack`, payload: { acquisitionId: pack.id, units: ["Nope/"] } });
  assert.equal(refused.statusCode, 400, refused.body);
  const chosen = await app.inject({ method: "POST", url: `/api/works/${work(4)}/pack`, payload: { acquisitionId: pack.id, units: [extras.key] } });
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.equal(chosen.json().mediaState.state, "available");
  assert.deepEqual(fileIds(packEditionId(pack, work(4))), [40]);
  // Chosen once: the pack no longer waits for it.
  assert.deepEqual((await app.inject({ method: "GET", url: `/api/works/${work(4)}/pack` })).json().choices, []);
  const again = await app.inject({ method: "POST", url: `/api/works/${work(4)}/pack`, payload: { acquisitionId: pack.id, units: [extras.key] } });
  assert.equal(again.statusCode, 409, again.body);
});

test("a book wanted later shares the pack already downloaded: no second download, no search", async () => {
  purgeEditionForTests("own-beta");
  const before = created.length;
  const searches = searched.length;
  // The series saved again asks for its audio again.
  sqlite.prepare("UPDATE series_acquisition_jobs SET status='pending', error=NULL WHERE work_id=? AND kind='audio'").run(work(2));
  await tickSeriesAcquisition();
  const pack = acquisitionOf(PACK_HASH)!;
  assert.equal(created.length, before);
  assert.equal(searched.length, searches);
  assert.equal(packRow(pack.id, work(2))?.status, "ready");
  assert.deepEqual(fileIds(packEditionId(pack, work(2))), [20]);
  assert.equal(getWorkMediaState(1, work(2))?.state, "available");
});

test("the Get sheet's describe names a pack's books and the ones it also gets", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/api/works/${work(5)}/packs/describe`,
    payload: { titles: ["Pack Saga Books 3-5 [MP3]", "Pack Saga Books 1-4", "Something else"] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const packs = response.json().packs;
  // "Books 1-4" does not hold book 5; another title is no pack.
  assert.deepEqual(Object.keys(packs), ["Pack Saga Books 3-5 [MP3]"]);
  const view = packs["Pack Saga Books 3-5 [MP3]"];
  assert.equal(view.from, 3);
  assert.equal(view.to, 5);
  assert.deepEqual(view.books.map((book: { position: number; hasAudio: boolean }) => [book.position, book.hasAudio]), [[3, true], [4, true], [5, true]]);
  // A book outside the user's saved series has no pack.
  assert.equal(describePack(1, "work-nobody", "Pack Saga Books 3-5"), null);
});

// A local pack: real WAV files under MEDIA_ROOT, imported as the download queue imports a finished torrent.
function wave() {
  const n = 800;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

test("removing a book keeps the pack's files while another book uses them; the last book takes them all", async () => {
  const LOCAL = "sr-local-saga";
  const local = (n: number) => `w-local-${n}`;
  seedSeries(LOCAL, "Local Saga", 3, local);
  const names = ["Local Saga 1-3/Alpha/a1.wav", "Local Saga 1-3/Alpha/a2.wav", "Local Saga 1-3/Beta/b.wav", "Local Saga 1-3/Gamma/g.wav"];
  const files = names.map((name, index) => {
    const path = join(completedDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, wave());
    return { key: String(index), name, path };
  });
  const id = "local-pack-acquisition";
  db.insert(s.acquisitions)
    .values({
      id,
      hash: "d".repeat(40),
      magnet: magnet("d".repeat(40), "Local"),
      backend: "local",
      remoteId: "d".repeat(40),
      title: "Local Saga 1-3",
      author: "Ada Author",
      cover: "",
      workId: local(1),
      status: "downloading",
      progress: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(s.userAcquisitions).values({ userId: 1, acquisitionId: id }).run();
  recordPack(id, {
    seriesId: LOCAL,
    seriesName: "Local Saga",
    volumes: [1, 2, 3].map((n) => ({ position: n, title: TITLES[n - 1] })),
    works: [1, 2, 3].map((n) => ({ workId: local(n), position: n, title: TITLES[n - 1] })),
  });
  const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()!;
  assert.equal(await importPack(job, files), packEditionId(job, local(1)));
  assert.deepEqual(tracksOf(packEditionId(job, local(1))).map((track) => track.source), [files[0].path, files[1].path]);

  // Book 1 goes: its recording goes, its files stay (the pack serves books 2 and 3), the pack is not cancelled.
  const first = await removeSavedSeries(1, LOCAL, [`${LOCAL}-bk-1`]);
  assert.deepEqual(first.fileErrors, []);
  assert.equal(db.select().from(s.editions).where(eq(s.editions.id, packEditionId(job, local(1)))).get(), undefined);
  assert.ok(files.every((file) => existsSync(file.path)));
  const after1 = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()!;
  assert.notEqual(after1.status, "error");
  // The acquisition's own book is now another of the pack's.
  assert.notEqual(after1.workId, local(1));
  assert.ok(db.select().from(s.userAcquisitions).where(eq(s.userAcquisitions.acquisitionId, id)).get());
  // Book 2 still plays from its own files.
  assert.equal(getWorkMediaState(1, local(2))?.state, "available");

  // Books 2 and 3 go together: they were the last, so every audio file of the pack goes, book 1's too.
  seedSavedAgain(LOCAL, local);
  const rest = await removeSavedSeries(1, LOCAL, [`${LOCAL}-bk-2`, `${LOCAL}-bk-3`]);
  assert.deepEqual(rest.fileErrors, []);
  assert.ok(files.every((file) => !existsSync(file.path)), "no file of the pack is left");
  assert.equal(db.select().from(s.acquisitionPacks).where(eq(s.acquisitionPacks.acquisitionId, id)).get(), undefined);
});

/** The first removal removes the saved series; the second removes the other books of it, saved again. */
function seedSavedAgain(series: string, prefix: (n: number) => string) {
  sqlite.prepare("INSERT OR IGNORE INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,?,?)").run(series, Date.now());
  for (const n of [2, 3])
    sqlite.prepare("INSERT OR IGNORE INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(1,?,?,?,1)").run(series, `${series}-bk-${n}`, prefix(n));
}

test("Get with a pack for a book also gets the series' other books it holds that have no audio", async () => {
  const GET = "sr-get-saga";
  const get = (n: number) => `w-get-${n}`;
  seedSeries(GET, "Get Saga", 3, get);
  // Book 3 has audio already: the pack does not get it again.
  db.insert(s.editions).values({ id: "own-gamma", workId: get(3), cover: "", narrator: "N", rating: 0, sourceLabel: "Local" }).run();
  db.insert(s.recordings).values({ id: "rec-own-gamma", editionId: "own-gamma" }).run();
  db.insert(s.tracks).values({ id: "t-own-gamma", recordingId: "rec-own-gamma", title: "c", index: 0, duration: 1, source: "/dev/null", sourceType: "local" }).run();
  const title = "Get Saga Books 1-3 [M4B]";
  const pack = packRequestFor(1, get(2), title)!;
  assert.deepEqual(pack.works.map((book) => book.workId), [get(1), get(2)]);
  assert.deepEqual(describePack(1, get(2), title)?.view.books.map((book) => [book.position, book.gets]), [[1, true], [2, true], [3, false]]);
  const job = await acquireReplacing(magnet("e".repeat(40), title), { workId: get(2), title, pack, userId: 1 });
  assert.equal(job.status, "ready", job.error ?? "");
  // Book 2 was asked for, book 1 came with it: each its own recording of its own file.
  assert.deepEqual(fileIds(packEditionId(job, get(2))), [2]);
  assert.deepEqual(fileIds(packEditionId(job, get(1))), [1]);
  assert.equal(packRow(job.id, get(3)), undefined);
  assert.equal(getWorkMediaState(1, get(1))?.state, "available");
});

test("replacing a pack on its way from one book's Get sheet lets only that book go; the others keep the download", async () => {
  const { replacePreviousAcquisition } = await import("../server/acquisitions.ts");
  const REPLACE = "sr-replace-saga";
  const book = (n: number) => `w-replace-${n}`;
  seedSeries(REPLACE, "Replace Saga", 2, book);
  const id = "replace-pack-acquisition";
  db.insert(s.acquisitions)
    .values({ id, hash: "9".repeat(40), magnet: magnet("9".repeat(40), "Replace"), backend: "local", remoteId: "9".repeat(40), title: "Replace Saga 1-2", author: "Ada Author", cover: "", workId: book(1), status: "downloading", progress: 0.4, createdAt: Date.now(), updatedAt: Date.now() })
    .run();
  db.insert(s.userAcquisitions).values({ userId: 1, acquisitionId: id }).run();
  recordPack(id, { seriesId: REPLACE, seriesName: "Replace Saga", volumes: [1, 2].map((n) => ({ position: n, title: TITLES[n - 1] })), works: [1, 2].map((n) => ({ workId: book(n), position: n, title: TITLES[n - 1] })) });
  assert.equal(getWorkMediaState(1, book(1))?.state, "queued");
  const result = await replacePreviousAcquisition(1, id, magnet("8".repeat(40), "Another"), book(1));
  assert.deepEqual(result, { action: "detached_shared" });
  const pack = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()!;
  assert.equal(pack.status, "downloading");
  assert.equal(pack.workId, book(2));
  assert.equal(packRow(id, book(1)), undefined);
  assert.equal(getWorkMediaState(1, book(2))?.state, "queued");
  assert.notEqual(getWorkMediaState(1, book(1))?.state, "queued");
});
