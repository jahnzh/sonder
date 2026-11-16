// Measures `GET /api/library` (#485) on a synthetic library in a temp folder: 100 works, 40 of them
// with a recording of 50 tracks (half local files, half remote with a server copy on every other
// one), the other 60 with only a placeholder. Prints the first read, an unchanged read answered
// "not modified", one after the remembered file checks expired, and one after an unrelated database
// write. Evidence for a report, not a test.
//
//   npx tsx scripts/bench-library-read.ts [rounds]
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] || 20);
const temp = mkdtempSync(join(tmpdir(), "sonder-bench-library-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "bench-password";

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const TOKEN = "bench-owner-token";
const T0 = Date.UTC(2026, 0, 1);
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const media = join(process.env.MEDIA_ROOT, "bench");
mkdirSync(media, { recursive: true });
sqlite.transaction(() => {
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,1)", hashToken(TOKEN), Date.now() + 86_400_000);
  for (let w = 0; w < 100; w++) {
    const workId = `work-hc-${1000 + w}`;
    run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", workId, `Work ${w}`, "A", "D", "G", 2000);
    const real = w < 40;
    const editionId = real ? `ed-${w}` : `hc-${1000 + w}`;
    run(
      "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,?,?,?,?)",
      editionId, workId, "/c.jpg", "N", "en", "R", 4, "S",
    );
    const recordingId = `recording-${editionId}`;
    run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", recordingId, editionId);
    run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(1,?,'unread',?)", editionId, T0 + w);
    if (!real) continue;
    for (let t = 0; t < 50; t++) {
      const trackId = `t-${w}-${t}`;
      const local = t % 2 === 0;
      const path = join(media, `${trackId}.mp3`);
      if (local) writeFileSync(path, "audio");
      run(
        "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,?,?,?,?,?)",
        trackId, recordingId, `Part ${t}`, t, 600, local ? path : `https://audio.example/${trackId}.mp3`,
        local ? "local" : "remote", JSON.stringify([{ title: `Chapter ${t}`, start: 0, end: 600 }]),
      );
      if (!local && t % 4 === 1) {
        writeFileSync(path, "copy");
        run("INSERT INTO media_copies(track_id,path,size,mime) VALUES(?,?,?,?)", trackId, path, 4, "audio/mpeg");
      }
    }
    run("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(1,?,?,?,?,?)", recordingId, `t-${w}-0`, 10, 600, T0);
  }
})();

const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
const read = (headers: Record<string, string> = {}) =>
  app.inject({ url: "/api/library", headers, cookies: { sonder_session: TOKEN } });
const timed = async (headers?: Record<string, string>) => {
  const start = performance.now();
  const response = await read(headers);
  return { ms: performance.now() - start, response };
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fmt = (ms: number) => `${ms.toFixed(1)} ms`;

const first = await timed();
if (first.response.statusCode !== 200) throw new Error(`first read: ${first.response.statusCode} ${first.response.body}`);
const tag = String(first.response.headers.etag);
const unchanged: number[] = [];
for (let i = 0; i < rounds; i++) {
  const { ms, response } = await timed({ "if-none-match": tag });
  if (response.statusCode !== 304) throw new Error(`unchanged read: ${response.statusCode}`);
  unchanged.push(ms);
}
// Before #485 round 1 there are no remembered file checks; then this is one more unchanged read.
const presence = (await import("../server/library-works.ts")) as { filePresence?: { ttlMs: number; now: () => number } };
let clock = Date.now();
if (presence.filePresence) presence.filePresence.now = () => clock;
const expired: number[] = [];
for (let i = 0; i < rounds; i++) {
  clock += presence.filePresence?.ttlMs ?? 0;
  const { ms, response } = await timed({ "if-none-match": tag });
  if (response.statusCode !== 304) throw new Error(`read after the file checks expired: ${response.statusCode}`);
  expired.push(ms);
}
const afterWrite: number[] = [];
for (let i = 0; i < rounds; i++) {
  // A write the library does not show (a setting), as background jobs make all the time.
  run("INSERT INTO settings(key,value) VALUES('bench',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(i));
  const { ms, response } = await timed({ "if-none-match": tag });
  if (response.statusCode !== 304) throw new Error(`read after an unrelated write: ${response.statusCode}`);
  afterWrite.push(ms);
}
console.log(`works=100 recordings=40 tracks=2000 body=${first.response.body.length} bytes tag=${tag} rounds=${rounds}`);
console.log(`first read (200):                       ${fmt(first.ms)}`);
console.log(`unchanged read (304), median / max:     ${fmt(median(unchanged))} / ${fmt(Math.max(...unchanged))}`);
console.log(`file checks expired (304), median / max:  ${fmt(median(expired))} / ${fmt(Math.max(...expired))}`);
console.log(`after an unrelated write (304), median / max: ${fmt(median(afterWrite))} / ${fmt(Math.max(...afterWrite))}`);
await app.close();
sqlite.close();
