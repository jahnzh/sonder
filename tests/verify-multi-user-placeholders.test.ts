// The multi-user live check's placeholder rule (#617): it recognises a placeholder by the one rule (an audio edition
// whose recordings have no track, #483), never by the `hc-` prefix. A throwaway database read as the administrator
// and as a fresh user (the live check's QA user, who owns nothing).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
// @ts-expect-error Plain JS module shared with scripts/verify-multi-user.mjs (no .d.ts)
import { assertNoLeakedPlaceholders, leakedPlaceholders } from "../scripts/multi-user-placeholders.mjs";

const temp = tempDir("sonder-verify-mu-placeholders-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const OWNER = 1;
const QA = 2;
const TOKENS: Record<number, string> = { [OWNER]: "owner-token", [QA]: "qa-token" };
const T0 = Date.UTC(2026, 0, 1);

const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
for (const [id, name, role] of [[OWNER, "admin", "admin"], [QA, "qa-user", "user"]] as const) {
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,?,NULL,?,?)", id, name, role, T0);
  run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(TOKENS[id]), Date.now() + 86_400_000, id);
}
const work = (id: string, title: string) =>
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'An Author','About it.','Fiction',2001)", id, title);
// A book with tracks, in the administrator's library (also keeps the demo seed out).
work("w-audio", "With Audio");
run(
  "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES('ed-audio','w-audio','/covers/real.jpg','A Narrator','en',NULL,4,'Test source')",
);
run("INSERT INTO recordings(id,edition_id) VALUES('rec-audio','ed-audio')");
run(
  "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES('t-audio','rec-audio','Part 1',0,600,'https://audio.example/a.mp3','remote','[]')",
);
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,'ed-audio','unread',?)", OWNER, T0);
run("INSERT INTO user_settings(user_id,key,value) VALUES(?,'shelfEbooksJoined','1')", OWNER);

const { createApp } = await import("../server/app.ts");
const { ensurePlaceholder } = await import("../server/placeholder-edition.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
  sqlite.close();
});

// An ebook-only book's placeholder (#555), owned by the administrator: its id has no `hc-` prefix.
work("w-ebook-only", "Only An Ebook");
const placeholderId: string = ensurePlaceholder(sqlite, "w-ebook-only");
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,'unread',?)", OWNER, placeholderId, T0);

const books = async (userId: number) => {
  const response = await app.inject({ url: "/api/books", cookies: { sonder_session: TOKENS[userId] } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { id: string; title: string; tracks?: unknown[] }[];
};

test("the placeholder under test has no hc- prefix and is the administrator's", async () => {
  assert.ok(!placeholderId.startsWith("hc-"), placeholderId);
  const owner = await books(OWNER);
  assert.ok(owner.some((b) => b.id === placeholderId), "the administrator sees the placeholder");
});

test("a placeholder without the hc- prefix visible to the user fails the check; a book with tracks does not", async () => {
  // The administrator's listing stands in for a user's listing that leaks it.
  const leaking = await books(OWNER);
  assert.deepEqual(leakedPlaceholders(leaking).map((b: { id: string }) => b.id), [placeholderId]);
  assert.throws(() => assertNoLeakedPlaceholders(leaking), new RegExp(`Only An Ebook \\(${placeholderId}\\)`));
  // Only the book with tracks: nothing leaks.
  assert.doesNotThrow(() => assertNoLeakedPlaceholders(leaking.filter((b) => b.id === "ed-audio")));
  assert.deepEqual(leakedPlaceholders(leaking.filter((b) => b.id === "ed-audio")), []);
});

test("an hc- placeholder is caught by the same rule, not by its id", () => {
  const rows = [
    { id: "hc-42", title: "Hardcover", tracks: [] },
    { id: "hc-43", title: "Hardcover with audio", tracks: [{ id: "t" }] },
    { id: "some-later-id", title: "Later" },
  ];
  assert.deepEqual(leakedPlaceholders(rows).map((b: { id: string }) => b.id), ["hc-42", "some-later-id"]);
});

test("a fresh user's own listing passes: the server hides the administrator's placeholder from that user", async () => {
  const qa = await books(QA);
  assert.ok(qa.some((b) => b.id === "ed-audio"), "the user sees the book with tracks");
  assert.doesNotThrow(() => assertNoLeakedPlaceholders(qa));
});
