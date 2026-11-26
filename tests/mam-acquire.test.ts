// A MyAnonamouse torrent's rules (#911): it goes to the local client only, never to TorBox, from MAM's own `.torrent`
// (the recorded one, its passkey replaced), with no ratio or idle limit; the magnet kept names only its hash; Cancel,
// a replacement and removing its book never stop or remove it before it has seeded 72 hours, and its files are never
// deleted while it seeds. A fake Transmission answers; TorBox would be asked through `fetch`, which fails the test.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-mam-acquire-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.TRANSMISSION_RPC_URL = "http://transmission.invalid/transmission/rpc";
delete process.env.TRANSMISSION_USERNAME;
delete process.env.TRANSMISSION_DOWNLOAD_DIR;

const TORRENT = readFileSync(new URL("./fixtures/myanonamouse/892986.torrent", import.meta.url));
const HASH = "f12991833230a9155ba6955c2aaac69206beac35";
const NAME = "Matt Dinniman - Dungeon Crawler Carl 1 - Dungeon Crawler Carl";

const rpc: Array<{ method: string; arguments: Record<string, unknown> }> = [];
const elsewhere: string[] = [];
let addedHash = HASH;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("http://transmission.invalid/")) {
    elsewhere.push(url);
    throw new Error(`No network in this test: ${url}`);
  }
  const call = JSON.parse(String(init?.body)) as { method: string; arguments: Record<string, unknown> };
  rpc.push(call);
  const answers: Record<string, unknown> = {
    "session-get": { version: "4.0.6", "download-dir": "/downloads/complete", "incomplete-dir": "", "incomplete-dir-enabled": false },
    "port-test": { "port-is-open": true },
    "torrent-add": { "torrent-added": { id: 7, hashString: addedHash, name: NAME } },
    "torrent-get": {
      torrents: [
        { id: 7, hashString: addedHash, name: NAME, downloadDir: "/downloads/complete", percentDone: 0.2, status: 4, rateDownload: 0, eta: 0, error: 0, errorString: "", files: [], fileStats: [], secondsSeeding: 0, uploadRatio: 0 },
      ],
    },
  };
  return new Response(JSON.stringify({ result: "success", arguments: answers[call.method] ?? {} }), { status: 200 });
}) as typeof fetch;

const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { acquire, cancelAcquisition, controlAcquisition, replacePreviousAcquisition, setAcquireDeps, MAM_MIN_SEED_SECONDS } = await import("../server/acquisitions.ts");
const { mamLink } = await import("../server/sources/myanonamouse.ts");
const { pathOfSeedingTorrent } = await import("../server/series-removal.ts");

// TorBox is connected: a MAM torrent must still never be offered to it.
db.insert(s.settings).values({ key: "torbox", value: encrypt("mam-acquire-key") }).run();
db.insert(s.works).values({ id: "work-dcc", title: "Dungeon Crawler Carl", author: "Matt Dinniman", description: "", genre: "", year: 2020 }).run();

let fetchedTorrents: number[] = [];
setAcquireDeps({
  mamTorrentFile: async (id) => {
    fetchedTorrents.push(id);
    return TORRENT;
  },
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TRANSMISSION_RPC_URL;
  sqlite.close();
});
beforeEach(() => {
  rpc.length = 0;
  elsewhere.length = 0;
  fetchedTorrents = [];
  addedHash = HASH;
});

const row = () => db.select().from(s.acquisitions).where(eq(s.acquisitions.hash, HASH)).get()!;

test("a MAM torrent goes to the local client from its own .torrent, never to TorBox, and seeds with no limit", async () => {
  const job = await acquire(mamLink(892986), { workId: "work-dcc", title: "Dungeon Crawler Carl", kind: "ebook" });
  assert.equal(job.backend, "local");
  assert.equal(job.status, "downloading");
  assert.deepEqual(fetchedTorrents, [892986]);
  // Nothing but the local client was asked: TorBox never.
  assert.deepEqual(elsewhere, []);
  const add = rpc.find((call) => call.method === "torrent-add")!;
  assert.equal(add.arguments.metainfo, TORRENT.toString("base64"));
  assert.equal(add.arguments.filename, undefined);
  assert.deepEqual(add.arguments.labels, ["sonder", "mam"]);
  const limits = rpc.find((call) => call.method === "torrent-set")!;
  assert.deepEqual(limits.arguments, { ids: [HASH], seedRatioMode: 2, seedIdleMode: 2 });
  const stored = row();
  assert.equal(stored.mamTorrentId, "892986");
  assert.equal(stored.seedPath, join(temp, "media", "complete", NAME));
  // The magnet kept is the hash and the name: no tracker, so no passkey, is written in the database.
  assert.equal(stored.magnet, `magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(NAME)}`);
  assert.equal(JSON.stringify(stored).includes("PASSKEY"), false);
  // An ebook of a MAM torrent is fetched whole: no file is marked unwanted (it is seeded as it is).
  assert.equal(rpc.some((call) => call.method === "torrent-set" && "files-unwanted" in call.arguments), false);
});

test("the same MAM torrent asked again joins the download: no second .torrent, no second add", async () => {
  const again = await acquire(mamLink(892986), { workId: "work-dcc", title: "Dungeon Crawler Carl" });
  assert.equal(again.id, row().id);
  assert.deepEqual(fetchedTorrents, []);
  assert.equal(rpc.some((call) => call.method === "torrent-add"), false);
});

test("a retry of a failed MAM download fetches its .torrent again and stays local", async () => {
  db.update(s.acquisitions).set({ status: "error", error: "x" }).where(eq(s.acquisitions.id, row().id)).run();
  await controlAcquisition(row().id, "retry", 1);
  assert.deepEqual(fetchedTorrents, [892986]);
  assert.deepEqual(elsewhere, []);
  assert.ok(rpc.some((call) => call.method === "torrent-add" && call.arguments.metainfo));
});

test("Cancel keeps a MAM torrent seeding until it has seeded 72 hours; then it may remove it", async () => {
  const removed: string[] = [];
  const first = await cancelAcquisition(row().id, { removeTorrent: async (hash) => void removed.push(hash), seedingSeconds: async () => 3600 });
  assert.equal(removed.length, 0);
  assert.deepEqual(first, { ok: true, removed: false, seeding: true });
  assert.equal(row().status, "cancelled");
  // Not known (the client did not answer) is not enough either.
  db.update(s.acquisitions).set({ status: "error" }).where(eq(s.acquisitions.id, row().id)).run();
  await cancelAcquisition(row().id, { removeTorrent: async (hash) => void removed.push(hash), seedingSeconds: async () => null });
  assert.equal(removed.length, 0);
  db.update(s.acquisitions).set({ status: "error" }).where(eq(s.acquisitions.id, row().id)).run();
  const late = await cancelAcquisition(row().id, { removeTorrent: async (hash) => void removed.push(hash), seedingSeconds: async () => MAM_MIN_SEED_SECONDS });
  assert.deepEqual(removed, [HASH]);
  assert.equal(late.removed, true);
});

test("a MAM download replaced by another recording is not stopped: it finishes and seeds on", async () => {
  db.update(s.acquisitions).set({ status: "downloading" }).where(eq(s.acquisitions.id, row().id)).run();
  db.insert(s.userAcquisitions).values({ userId: 1, acquisitionId: row().id }).onConflictDoNothing().run();
  const result = await replacePreviousAcquisition(1, row().id, `magnet:?xt=urn:btih:${"b".repeat(40)}`);
  assert.equal(result.action, "stopped_local");
  assert.equal(rpc.some((call) => call.method === "torrent-stop" || call.method === "torrent-remove"), false);
});

test("the files of a MAM torrent are never deleted with its book while it seeds; another download's are not protected", () => {
  const seeded = join(temp, "media", "complete", NAME);
  mkdirSync(seeded, { recursive: true });
  const file = join(seeded, "Dungeon Crawler Carl.epub");
  writeFileSync(file, "epub");
  const other = join(temp, "media", "complete", "Another Torrent", "01.mp3");
  mkdirSync(join(temp, "media", "complete", "Another Torrent"), { recursive: true });
  writeFileSync(other, "mp3");
  assert.equal(pathOfSeedingTorrent(file), true);
  assert.equal(pathOfSeedingTorrent(other), false);
});

test("a torrent client that adds another torrent than MAM's is refused", async () => {
  addedHash = "c".repeat(40);
  await assert.rejects(acquire(mamLink(892987), { workId: "work-dcc", title: "Dungeon Crawler Carl" }), /another torrent than MyAnonamouse/);
});

test("the series queue does not ask MAM while it refuses the saved session", async () => {
  const { mamUsable } = await import("../server/sources/myanonamouse.ts");
  assert.equal(mamUsable(), false);
  db.insert(s.settings).values({ key: "mam", value: encrypt("a-session-of-twenty-chars") }).run();
  assert.equal(mamUsable(), true);
  db.insert(s.settings).values({ key: "mamRefusedAt", value: String(Date.now()) }).run();
  assert.equal(mamUsable(), false);
});

test("Activity's MAM row: seeding time and ratio from the client; a torrent the client lost or stopped says so", async () => {
  const { mamSeedingOf } = await import("../server/mam-routes.ts");
  const torrent = { id: "a", title: "Dungeon Crawler Carl", hash: HASH };
  const state = { hashString: HASH, status: 6, percentDone: 1, secondsSeeding: 80 * 3600, uploadRatio: 1.5, uploadedEver: 1, error: 0, errorString: "" };
  assert.deepEqual(mamSeedingOf(torrent, state), { id: "a", title: "Dungeon Crawler Carl", state: "seeding", progress: 1, secondsSeeding: 80 * 3600, ratio: 1.5, seededEnough: true });
  assert.equal(mamSeedingOf(torrent, { ...state, status: 0, secondsSeeding: 10 }).state, "stopped");
  assert.equal(mamSeedingOf(torrent, { ...state, uploadRatio: -1 }).ratio, null);
  assert.equal(mamSeedingOf(torrent, undefined).state, "missing");
});
