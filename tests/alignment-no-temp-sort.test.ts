// No statement that reads a job's map may sort or group (#849): `alignment_jobs.data` and `published_map` hold
// megabytes of JSON a row, and a statement that orders such rows makes SQLite write them all to a temporary file.
// Production's temporary folder is 64 MB; on 20 Nov 2026 the maps outgrew it and every listing failed with
// SQLITE_FULL "database or disk is full". The listings order the ids and read each row by its id.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-alignment-sort-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
const { sqlite } = await import("../server/db.ts");
const { listAlignmentJobs, listServedAlignmentJobs, listServedAlignmentSummaries, alignmentJob, servedAlignmentJob } = await import("../server/alignment-transitions.ts");
after(() => sqlite.close());

sqlite.exec(`
  INSERT INTO works(id,title,author,description,genre,year) VALUES('w','Work','A','','',2000);
  INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ae','w','','',0,'');
`);
const job = (n: number, updatedAt: number, kept = false) => {
  const id = `job-${n}`;
  sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,'ae')").run(`rec-${n}`);
  sqlite.prepare("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,'w','epub','/nowhere')").run(`eb-${n}`);
  const data = (status: string) => JSON.stringify({ id, ebookId: `eb-${n}`, recordingId: `rec-${n}`, status, progress: 1, engine: "e", error: null, warning: null, intervals: [{ paragraphId: "0:0", section: 0, trackId: "t", start: 0, end: 1, confidence: 1 }], sectionsDone: [], elapsedSeconds: 0, fingerprint: "f", audioFingerprint: "a", updatedAt, createdAt: updatedAt, coverage: 1, pairings: [] });
  sqlite
    .prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at,engine,outcome,stage_timings,published_map) VALUES(?,?,?,?,?,'e',NULL,NULL,?)")
    .run(id, `eb-${n}`, `rec-${n}`, data(kept ? "queued" : "ready"), updatedAt, kept ? data("ready") : null);
  return id;
};
// Stored in another order than they were last written.
job(1, 2000);
job(2, 5000, true);
job(3, 1000);
job(4, 4000);
job(5, 3000);
const newestFirst = ["job-2", "job-4", "job-5", "job-1", "job-3"];

/** The statements a call prepares, read off the database handle. */
function statementsOf(call: () => unknown) {
  const seen: string[] = [];
  const prepare = sqlite.prepare.bind(sqlite);
  (sqlite as { prepare: unknown }).prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  try {
    call();
  } finally {
    (sqlite as { prepare: unknown }).prepare = prepare;
  }
  return seen;
}
const readsAMap = (sql: string) => /\balignment_jobs\b/.test(sql) && /\b(data|published_map)\b/.test(sql.replace(/\bupdated_at\b/g, ""));
/** What SQLite will do for a statement, with a placeholder value for each of its parameters. */
const planOf = (sql: string) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: (sql.match(/\?/g) || []).length }, () => "[]")) as { detail: string }[]).map((row) => row.detail);

test("the listings return the jobs newest first", () => {
  assert.deepEqual(listAlignmentJobs().map((entry) => entry.id), newestFirst);
  assert.deepEqual(listServedAlignmentJobs().map((entry) => entry.id), newestFirst);
  const recordings = [1, 2, 3, 4, 5].map((n) => `rec-${n}`);
  assert.deepEqual(listServedAlignmentSummaries(recordings).map((entry) => entry.id), newestFirst);
  assert.deepEqual(listServedAlignmentSummaries(["rec-3", "rec-4"]).map((entry) => entry.id), ["job-4", "job-3"]);
  // What they return is what it was: the whole job, the kept map in front of a rebuild, the count in the summary.
  assert.equal(listAlignmentJobs()[0].status, "queued");
  assert.equal(listServedAlignmentJobs()[0].status, "ready");
  assert.equal(listServedAlignmentJobs()[0].intervals.length, 1);
  assert.deepEqual([listServedAlignmentSummaries(recordings)[0].intervalCount, listServedAlignmentSummaries(recordings)[0].intervals], [1, []]);
});

test("no statement of the listings that reads a job's map sorts or groups in a temporary b-tree", () => {
  const calls: [string, () => unknown][] = [
    ["listAlignmentJobs", () => listAlignmentJobs()],
    ["listServedAlignmentJobs", () => listServedAlignmentJobs()],
    ["listServedAlignmentSummaries", () => listServedAlignmentSummaries(["rec-1", "rec-2", "rec-3", "rec-4", "rec-5", "rec-new"])],
    ["alignmentJob", () => alignmentJob("job-1")],
    ["servedAlignmentJob", () => servedAlignmentJob("job-2")],
  ];
  // A row written since the summaries were last read, so the statement that reads the changed rows runs too.
  sqlite.prepare("UPDATE alignment_jobs SET updated_at=updated_at+1 WHERE id='job-3'").run();
  let checked = 0;
  const texts: string[] = [];
  for (const [name, call] of calls) {
    const statements = statementsOf(call).filter(readsAMap);
    assert.ok(statements.length > 0, `${name} reads a map`);
    for (const sql of statements) {
      const plan = planOf(sql);
      assert.ok(!plan.some((step) => /TEMP B-TREE/.test(step)), `${name}: ${sql.replace(/\s+/g, " ")}\n  plan: ${plan.join(" | ")}`);
      checked++;
      texts.push(sql);
    }
  }
  assert.equal(checked, 6, texts.join("\n"));
  assert.ok(texts.some((sql) => /json_set\(data/.test(sql)) && texts.some((sql) => /octet_length\(data\)/.test(sql)), "both statements of the summary listing were checked");
  // The order comes from a statement that carries only ids.
  const ordering = statementsOf(() => listServedAlignmentJobs()).filter((sql) => /ORDER BY/i.test(sql));
  assert.deepEqual(ordering, ["SELECT id FROM alignment_jobs ORDER BY updated_at DESC"]);
});

test("no statement in the server's source orders, groups or deduplicates rows that carry a job's map", () => {
  // Every SQL text in server/ that names the table: one that selects `data` or `published_map` (as a column, or
  // inside json_set, json_extract, octet_length…) may not also say ORDER BY, GROUP BY, DISTINCT or UNION.
  const offenders: string[] = [];
  let seen = 0;
  for (const file of readdirSync("server").filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join("server", file), "utf8");
    // From SELECT or WITH to the end of the text it stands in (the next double quote or backtick).
    for (const found of source.matchAll(/\b(?:SELECT|WITH)\b[^"`]*?\balignment_jobs\b[^"`]*/g)) {
      const sql = found[0];
      seen++;
      if (readsAMap(sql) && /\b(ORDER\s+BY|GROUP\s+BY|DISTINCT|UNION)\b/i.test(sql)) offenders.push(`${file}: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  assert.ok(seen >= 10, `${seen} statements on the table were read from the source`);
  assert.deepEqual(offenders, []);
});
