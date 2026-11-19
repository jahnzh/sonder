/**
 * #717: on Activity, a failed series search says which search failed and why and offers Retry; a waiting one says
 * where it is in the one-at-a-time queue; a failure whose work has the file by now, by any route, is no longer listed.
 * Read through the real route and tables, as the administrator and as a second user.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-search-activity-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.TRANSMISSION_RPC_URL;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { setSeriesAcquisitionDeps, resetSeriesAcquisitionDeps, seriesWorkAcquisitions, tickSeriesAcquisition } =
  await import("../server/series-acquisition.ts");
const { buildNow } = await import("../src/activity-now.ts");
// The series loop never ticks on its own here.
const app = await createApp({ background: { manual: ["series-acquisition"] } });
after(async () => {
  resetSeriesAcquisitionDeps();
  await app.close();
});

const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;
const admin = await login("203.0.113.71", { password: "admin-password" });
assert.equal((await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username: "reader", password: "password1" } })).statusCode, 200);
const reader = await login("203.0.113.72", { username: "reader", password: "password1" });
const readerId = (sqlite.prepare("SELECT id FROM users WHERE username='reader'").get() as { id: number }).id;

const LIBGEN_DOWN = "Library Genesis could not be reached. Try another mirror in Settings or open the source website.";
const NOW = Date.now();
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
run("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(12717,'Dungeon Crawler Carl','Dinniman',7)");
const works = ["butcher", "gate", "dungeon", "fist", "eye", "bard", "march"];
works.forEach((id, index) => {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'Dinniman','','',2020)", `w-${id}`, `Book ${id}`);
  run("INSERT INTO series_catalogue_works(series_id,book_id,title,position,unreleased) VALUES(12717,?,?,?,0)", 700 + index, `Book ${id}`, index + 1);
});
/** Jobs in the queue's order: rows are inserted oldest first, as the series adds them. */
const job = (id: string, user: number, kind: "audio" | "ebook", status: string, error: string | null, retryAt: number | null = null) =>
  run("INSERT INTO series_acquisition_jobs(id,user_id,series_id,book_id,work_id,kind,status,error,updated_at,retry_at) VALUES(?,?,12717,?,?,?,?,?,?,?)",
    `job-${id}`, user, 700 + works.indexOf(id), `w-${id}`, kind, status, error, NOW - 60_000, retryAt);
// The owner's case (series 12717): the first book's ebook search failed on Library Genesis, the next one runs, four wait.
job("butcher", 1, "ebook", "failed", LIBGEN_DOWN);
job("gate", 1, "ebook", "searching", null);
job("dungeon", 1, "audio", "pending", null);
job("fist", readerId, "ebook", "pending", LIBGEN_DOWN, NOW + 5 * 60_000); // waits to try its source again
job("eye", 1, "ebook", "pending", null);
job("bard", 1, "audio", "pending", null);

const activity = async (cookie = admin) => app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: cookie } });
const itemOf = (body: { items: Array<{ id: string }> }, id: string) => body.items.find((item) => item.id === `series-acquisition:job-${id}`) as any;
const nowOf = (body: any) => buildNow({ activity: body, saves: [], books: [], admin: true, online: true, now: NOW });
const rowOf = (now: ReturnType<typeof buildNow>, id: string) => {
  for (const group of now.groups) {
    const row = group.rows.find((entry) => entry.workId === `w-${id}`);
    if (row) return { group: group.id, ...row };
  }
  return null;
};

test("the waiting series books say where they are in line; the one searched now is In progress (#717)", async () => {
  const body = (await activity()).json();
  assert.equal(itemOf(body, "gate").facts.place, null, "the search running now has no waiting place");
  assert.equal(itemOf(body, "dungeon").facts.place, 2, "first waiting, behind the search that runs");
  assert.equal(itemOf(body, "fist").facts.place, null, "a job waiting to try its source again is not in line yet");
  assert.equal(itemOf(body, "fist").facts.retryAt, NOW + 5 * 60_000);
  assert.equal(itemOf(body, "eye").facts.place, 3);
  assert.equal(itemOf(body, "bard").facts.place, 4);
  const now = nowOf(body);
  assert.deepEqual(rowOf(now, "gate") && [rowOf(now, "gate")!.group, rowOf(now, "gate")!.line], ["progress", "Searching for the ebook"]);
  assert.deepEqual([rowOf(now, "dungeon")!.group, rowOf(now, "dungeon")!.line], ["waiting", "Waiting · 2nd in line"]);
  assert.deepEqual([rowOf(now, "eye")!.group, rowOf(now, "eye")!.line], ["waiting", "Waiting · 3rd in line"]);
  assert.deepEqual([rowOf(now, "bard")!.group, rowOf(now, "bard")!.line], ["waiting", "Waiting · 4th in line"]);
  assert.deepEqual([rowOf(now, "fist")!.group, rowOf(now, "fist")!.line], ["waiting", "Waiting to try again · Library Genesis could not be reached"]);
});

test("a failed series search says which search failed and why, with Retry on its row (#717)", async () => {
  const body = (await activity()).json();
  const failed = itemOf(body, "butcher");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, LIBGEN_DOWN, "the stored reason");
  assert.deepEqual(failed.actions, ["retry"]);
  const row = rowOf(nowOf(body), "butcher")!;
  assert.equal(row.group, "attention");
  assert.equal(row.line, "Ebook search failed · Library Genesis could not be reached");
  assert.equal(row.failed, true);
  assert.deepEqual(row.button, { action: "retry", source: "server", itemId: "series-acquisition:job-butcher" });
});

test("Activity's Retry puts a failed series search back in the queue; it refuses one that has not failed (#717)", async () => {
  const searched: string[] = [];
  setSeriesAcquisitionDeps({
    canAcquireMedia: () => true,
    fetchEbooks: async (workId) => {
      searched.push(workId);
      return { downloaded: [{ id: "libgen-1dafeaa8", status: "held" as const }], skipped: null, failures: [] as string[] };
    },
  });
  const post = (cookie: string, id: string) =>
    app.inject({ method: "POST", url: "/api/activity/items/retry", cookies: { sonder_session: cookie }, payload: { id: `series-acquisition:${id}` } });
  // The second user can neither read Activity nor act on it.
  assert.equal((await activity(reader)).statusCode, 403);
  const refused = await post(reader, "job-butcher");
  assert.equal(refused.statusCode, 403, refused.body);
  assert.doesNotMatch(refused.body, /Library Genesis|butcher|pending/, "the refusal says nothing about the job");
  assert.equal((sqlite.prepare("SELECT status FROM series_acquisition_jobs WHERE id='job-butcher'").get() as { status: string }).status, "failed");

  assert.equal((await post(admin, "job-gate")).statusCode, 409, "a running search is not set again");
  assert.equal((await post(admin, "job-nothing")).statusCode, 404);
  // Let the other jobs wait, so the queue's run below reaches only the retried one.
  run("UPDATE series_acquisition_jobs SET status='done' WHERE id<>'job-butcher'");
  const retried = await post(admin, "job-butcher");
  assert.equal(retried.statusCode, 200, retried.body);
  assert.deepEqual(retried.json(), { ok: true, result: { id: "job-butcher", status: "pending" } });
  await tickSeriesAcquisition();
  assert.deepEqual(searched, ["w-butcher"]);
  assert.equal((sqlite.prepare("SELECT status FROM series_acquisition_jobs WHERE id='job-butcher'").get() as { status: string }).status, "done");
  resetSeriesAcquisitionDeps();
});

test("a failed search whose work has the file by now, by any route, is not listed, and the Series page shows it skipped (#717)", async () => {
  run("DELETE FROM series_acquisition_jobs");
  job("butcher", 1, "ebook", "failed", LIBGEN_DOWN);
  job("march", 1, "audio", "failed", "No release found");
  job("eye", readerId, "ebook", "failed", LIBGEN_DOWN);
  const ids = (answer: { items: Array<{ id: string; kind: string }> }) =>
    answer.items.filter((item) => item.kind === "series-acquisition").map((item) => item.id);
  let body = (await activity()).json();
  assert.deepEqual(ids(body).sort(), ["series-acquisition:job-butcher", "series-acquisition:job-eye", "series-acquisition:job-march"]);

  // The EPUB was saved by another route (the ebook search on the Book page).
  mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
  const epub = join(temp, "media", "ebooks", "butcher.epub");
  writeFileSync(epub, "epub");
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('libgen-1dafeaa8','w-butcher','epub',?)", epub);
  // A playable audiobook arrived for the other book.
  run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed-march','w-march','','',0,'')");
  run("INSERT INTO recordings(id,edition_id) VALUES('rec-march','ed-march')");
  run("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES('t-march','rec-march','Part 1',0,60,'/x.m4b','file')");
  // An ebook edition whose file is gone is no ebook.
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES('libgen-gone','w-eye','epub',?)", join(temp, "media", "ebooks", "missing.epub"));

  body = (await activity()).json();
  assert.deepEqual(ids(body), ["series-acquisition:job-eye"], "only the failure whose work still lacks its file");
  assert.equal(nowOf(body).dot, true);
  assert.equal(rowOf(nowOf(body), "butcher"), null, "Activity's item goes");

  // The Series page: the same rule, for the job's own user only.
  assert.deepEqual(seriesWorkAcquisitions(1, 12717, 700, "w-butcher", false).ebook, { kind: "ebook", status: "skipped", error: null, skipReason: "has_ebook" });
  assert.deepEqual(seriesWorkAcquisitions(1, 12717, 706, "w-march", false).audio, { kind: "audio", status: "skipped", error: null, skipReason: "has_audio" });
  assert.equal(seriesWorkAcquisitions(readerId, 12717, 700, "w-butcher", false).ebook, null, "the second user does not see the administrator's job");
  assert.equal(seriesWorkAcquisitions(readerId, 12717, 704, "w-eye", false).ebook?.status, "failed", "and their own failure is theirs");
  assert.equal(seriesWorkAcquisitions(1, 12717, 704, "w-eye", false).ebook, null);
});
