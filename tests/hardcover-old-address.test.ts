// What Hardcover's stored matches still decide after its removal (#721 part d, merged with parts b/c2), on a
// throwaway database, read as the owner (the administrator) and Sam (who is not):
// - an older build's address `work-hc-<n>` opens the work stored as matched to Hardcover book n, one in the
//   reader's own library first; Hardcover is never asked, and with no stored match the address is not found;
// - new media that names no work joins the one work with its title and author that Hardcover matched, never a work
//   only a catalogue link names, and none when two works match.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-hardcover-old-address-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = "owner-token";
const SAM = "sam-token";
const T0 = Date.UTC(2026, 0, 1);

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'sam',NULL,'user',?)", T0);
for (const [token, userId] of [[OWNER, 1], [SAM, 2]] as const)
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
/** A work with one streamed recording (so anyone may see it). */
function work(id: string, title: string, author: string) {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,'','Fiction',2000)", id, title, author);
  run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,'/covers/x.jpg','N',0,'Test')", `ed-${id}`, id);
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${id}`, `ed-${id}`);
  run(
    "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,'Part 1',0,600,?,'remote','[]')",
    `t-${id}`,
    `rec-${id}`,
    `https://audio.example/${id}.mp3`,
  );
}
// Hardcover book 77 was matched to two works; Sam has the second (made later) in his library.
work("w-first", "Shared", "Ann Author");
work("w-second", "Shared Too", "Ann Author");
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-first',77,'shared','[]'),('w-second',77,'shared','[]')");
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(2,'ed-w-second','unread',?)", T0);
// Media matching: one work Hardcover matched, one only AudiobookDB names, and two Hardcover matched under one title.
work("w-hc", "Harbour Lights", "Bo Writer");
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-hc',80,'harbour-lights','[]')");
work("w-abdb", "Quiet Harbour", "Mira Sand");
run(
  "INSERT INTO work_catalogue_links(work_id,provider,external_id,title,author,matched_by,linked_at) VALUES('w-abdb','audiobookdb','ab-1','Quiet Harbour','Mira Sand','title',?)",
  T0,
);
work("w-twin-a", "Twin", "Cy Twin");
work("w-twin-b", "Twin", "Cy Twin");
run("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('w-twin-a',81,'twin','[]'),('w-twin-b',82,'twin-2','[]')");

let hardcoverCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).includes("hardcover.app")) hardcoverCalls++;
  return realFetch(input, init);
};
const { createApp } = await import("../server/app.ts");
const { matchedWorkForMedia } = await import("../server/same-book.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});
const read = (token: string, url: string) => app.inject({ method: "GET", url, cookies: { sonder_session: token } });

test("an older build's work-hc address opens the stored match, the reader's own first; no match is not found", async () => {
  const owner = await read(OWNER, "/api/works/work-hc-77");
  assert.equal(owner.statusCode, 200, owner.body);
  assert.equal(owner.json().workId, "w-first", "the owner has neither in the library: the one made first");
  const sam = await read(SAM, "/api/works/work-hc-77");
  assert.equal(sam.statusCode, 200, sam.body);
  assert.equal(sam.json().workId, "w-second", "Sam's own work first");
  assert.equal((await read(SAM, "/api/works/work-hc-999")).statusCode, 404);
  assert.equal(hardcoverCalls, 0, "Hardcover is never asked");
});

test("new media joins only the one work Hardcover matched with its title and author", () => {
  assert.equal(matchedWorkForMedia("Harbour Lights", "Bo Writer"), "w-hc");
  assert.equal(matchedWorkForMedia("The Harbour Lights", "Writer Bo"), "w-hc", "an article and the name order are ignored");
  assert.equal(matchedWorkForMedia("Quiet Harbour", "Mira Sand"), undefined, "a catalogue link alone does not count");
  assert.equal(matchedWorkForMedia("Twin", "Cy Twin"), undefined, "two matches: none");
  assert.equal(matchedWorkForMedia("Harbour Lights", "Unknown author"), undefined);
});
