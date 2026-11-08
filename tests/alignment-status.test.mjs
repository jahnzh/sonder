import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildReport, checkHealth, formatReport, main, openReadOnly, parseArgs } from "../scripts/alignment-status.mjs";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alignment-status-"));
  const file = path.join(dir, "sonder.db");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE works(id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE ebook_editions(id TEXT PRIMARY KEY, work_id TEXT NOT NULL, format TEXT, source TEXT);
    CREATE TABLE alignment_jobs(id TEXT PRIMARY KEY, ebook_id TEXT, recording_id TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL, engine TEXT, outcome TEXT);
    CREATE TABLE work_ebook_set(work_id TEXT PRIMARY KEY, recording_id TEXT, consensus_job_id TEXT, default_ebook_id TEXT, default_ebook_override TEXT);
    CREATE TABLE work_ebook_set_members(work_id TEXT, ebook_id TEXT, status TEXT, hold_reason TEXT, source_title TEXT, language TEXT, byte_size INTEGER);
  `);
  db.prepare("INSERT INTO works VALUES('w1','Book')").run();
  db.prepare("INSERT INTO ebook_editions VALUES('e1','w1','epub','x'),('e2','w1','epub','y')").run();
  const data = {
    status: "processing", progress: 0.4, error: null, warning: null, coverage: 0.75,
    ctcDevice: "cuda", ctcPrecision: "float16", gpuUtilization: 47.2,
    pool: { hostId: "wsl", attempt: 1, workerUrl: "http://h:3012", triedHosts: ["wsl"] },
    poolErrors: { steamdeck: "ssh down" },
    anchoring: { stage: "aligning", anchors: [{}, {}, {}] },
    intervals: [{}, {}],
    unsyncedPassages: [{ sentenceCount: 3 }, { sentenceCount: 2 }],
  };
  db.prepare("INSERT INTO alignment_jobs VALUES('j1','e1','r1',?,1000,'ctc','partial')").run(JSON.stringify(data));
  db.prepare("INSERT INTO work_ebook_set VALUES('w1','r1','j1','e1',NULL)").run();
  db.prepare("INSERT INTO work_ebook_set_members VALUES('w1','e1','aligned',NULL,'Title','en',10),('w1','e2','held','mismatch','Other','en',20)").run();
  db.close();
  return { dir, file };
}

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ ready: true }) });

test("resolves job, recording and work ids to the same job", async () => {
  const { file } = makeDb();
  const db = openReadOnly(file);
  for (const [id, kind] of [["j1", "job"], ["r1", "recording"], ["w1", "work"]]) {
    const r = await buildReport(db, id, { fetchImpl: okFetch, healthUrl: "http://x" });
    assert.equal(r.kind, kind);
    assert.equal(r.jobs[0].id, "j1");
    assert.equal(r.workId, "w1");
  }
  db.close();
});

test("reports status, pool host, device, anchors, coverage and unsynced count", async () => {
  const { file } = makeDb();
  const db = openReadOnly(file);
  const { jobs } = await buildReport(db, "j1", { fetchImpl: okFetch, healthUrl: "http://x" });
  const j = jobs[0];
  assert.equal(j.status, "processing");
  assert.equal(j.poolHost, "wsl");
  assert.equal(j.device, "cuda");
  assert.equal(j.gpuUtilization, 47.2);
  assert.equal(j.anchors, 3);
  assert.equal(j.coverage, 0.75);
  assert.equal(j.unsyncedSentences, 5);
  assert.equal(j.unsyncedPassages, 2);
  db.close();
});

test("lists ebook-set members and the text output includes everything", async () => {
  const { file } = makeDb();
  const db = openReadOnly(file);
  const r = await buildReport(db, "w1", { fetchImpl: okFetch, healthUrl: "http://x" });
  assert.deepEqual(r.ebookSet.members.map((m) => m.ebook_id), ["e1", "e2"]);
  const text = formatReport(r);
  assert.match(text, /host=wsl device=cuda/);
  assert.match(text, /gpuUtilization=47%/);
  assert.match(text, /anchors=3/);
  assert.match(text, /coverage=75%/);
  assert.match(text, /e2 {2}held \(mismatch\)/);
  assert.match(text, /Worker health: ok/);
  db.close();
});

test("unknown id is handled gracefully with exit code 1", async () => {
  const { file } = makeDb();
  const db = openReadOnly(file);
  const r = await buildReport(db, "nope", { fetchImpl: okFetch, healthUrl: "http://x" });
  assert.equal(r.kind, "none");
  assert.match(formatReport(r), /No job, recording or work found for "nope"/);
  db.close();
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(["nope", "--db", file, "--health-url", ""]), 1);
  } finally {
    console.log = log;
  }
});

test("missing database and missing tables fail or degrade without throwing stack traces", async () => {
  assert.throws(() => openReadOnly(path.join(os.tmpdir(), "does-not-exist-alignment.db")), /Database not found/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alignment-status-empty-"));
  const file = path.join(dir, "sonder.db");
  new Database(file).close();
  const db = openReadOnly(file);
  const r = await buildReport(db, "x", { healthUrl: "" });
  assert.equal(r.kind, "none");
  assert.deepEqual((await buildReport(db, undefined, { healthUrl: "" })).jobs, []);
  db.close();
});

test("a work without jobs still shows its ebook-set members", async () => {
  const { file } = makeDb();
  const rw = new Database(file);
  rw.prepare("INSERT INTO works VALUES('w2','Empty')").run();
  rw.prepare("INSERT INTO work_ebook_set_members VALUES('w2','e9','held',NULL,NULL,NULL,NULL)").run();
  rw.close();
  const db = openReadOnly(file);
  const r = await buildReport(db, "w2", { healthUrl: "" });
  assert.equal(r.kind, "work");
  assert.equal(r.jobs.length, 0);
  assert.equal(r.ebookSet.members.length, 1);
  db.close();
});

test("health check times out, reports unreachable and unconfigured without throwing", async () => {
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  assert.equal((await checkHealth("http://x", { timeoutMs: 20, fetchImpl: hang })).state, "timeout");
  const refused = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal((await checkHealth("http://x", { fetchImpl: refused })).state, "unreachable");
  assert.equal((await checkHealth("")).state, "unconfigured");
  const bad = async () => ({ ok: false, status: 503, json: async () => { throw new Error("x"); } });
  const h = await checkHealth("http://x/", { fetchImpl: bad });
  assert.equal(h.state, "http_error");
  assert.equal(h.url, "http://x/health");
});

test("is strictly read-only: the database refuses writes and is unchanged", async () => {
  const { file } = makeDb();
  const before = fs.readFileSync(file);
  const db = openReadOnly(file);
  assert.throws(() => db.prepare("INSERT INTO works VALUES('w9','x')").run(), /readonly/i);
  await buildReport(db, "w1", { healthUrl: "" });
  db.close();
  assert.ok(before.equals(fs.readFileSync(file)));
  const src = fs.readFileSync(new URL("../scripts/alignment-status.mjs", import.meta.url), "utf8");
  assert.equal(/prepare\(\s*[`"']\s*(INSERT|UPDATE|DELETE)/i.test(src), false);
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["abc", "--json", "--db", "p"]), { id: "abc", db: "p", healthUrl: undefined, json: true });
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
});
