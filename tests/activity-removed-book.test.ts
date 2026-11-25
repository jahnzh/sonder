/**
 * A reading sync of a book that is not in the reader's library calls for no attention (#881): its failure lights no dot
 * and holds no row under Needs attention, though the job is unchanged and still listed. Through the real routes on a
 * throwaway database: removing the book (`DELETE /api/works/:workId/library`) silences its failed job, adding it back
 * (`PUT /api/works/:workId/library`) makes a failure younger than seven days count again, and a book never in the library has none.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-activity-removed-");
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
const app = await createApp();
after(async () => {
  await app.close();
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = Date.now();
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
const login = async (ip: string, payload: Record<string, string>) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload })).cookies[0].value;

// kept: in the library; gone: removed through the route; never: never added; old: removed, its failure older than a week.
for (const [work, title] of [["kept", "Kept"], ["gone", "Gone"], ["never", "Never"], ["old", "Old"]]) {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'Card','','',1986)", `w-${work}`, title);
  run("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,'','',0,'')", `ed-${work}`, `w-${work}`);
  run("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,'epub','x')", `eb-${work}`, `w-${work}`);
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${work}`, `ed-${work}`);
  run("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES(?,?,?,?,?)",
    `job-${work}`, `eb-${work}`, `rec-${work}`,
    JSON.stringify({ id: `job-${work}`, createdAt: now - 60 * MIN, status: "error", error: "The worker stopped.", progress: 0.4 }),
    now - (work === "old" ? 9 * DAY : MIN));
  if (work !== "never") run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(1,?,'unread',?)", `ed-${work}`, now);
}

const admin = await login("203.0.113.210", { password: "admin-password" });
const cookies = { sonder_session: admin };
const read = async () => {
  const response = await app.inject({ method: "GET", url: "/api/activity", cookies });
  assert.equal(response.statusCode, 200, response.body);
  const activity = response.json();
  const items = new Map<string, any>(activity.items.map((item: any) => [item.id, item]));
  const calling = activity.items.filter((item: any) => item.attention).map((item: any) => item.id).sort();
  const down = activity.processes.filter((process: any) => process.health === "down" && !process.notTracked).length;
  assert.equal(activity.attention, calling.length + down, "the count is the items with attention plus the processes that are down");
  return { activity, items, calling };
};

test("a failed reading sync of a book in the library needs attention", async () => {
  const { items, calling } = await read();
  assert.equal(items.get("alignment:job-kept").state, "failed");
  assert.deepEqual(calling, ["alignment:job-gone", "alignment:job-kept"]);
  assert.equal(items.get("alignment:job-old").attention, false, "a failure older than seven days never did");
});

test("removing the book silences its failed job, which stays listed and unchanged; a book never in the library has none", async () => {
  const before = (await read()).items.get("alignment:job-gone");
  for (const work of ["gone", "old"]) {
    const removed = await app.inject({ method: "DELETE", url: `/api/works/w-${work}/library`, cookies });
    assert.equal(removed.statusCode, 200, removed.body);
  }
  const { activity, items, calling } = await read();
  assert.deepEqual(calling, ["alignment:job-kept"]);
  const gone = items.get("alignment:job-gone");
  assert.equal(gone.attention, false);
  assert.equal(gone.state, "failed", "the job is not changed");
  assert.deepEqual(gone.actions, before.actions, "its actions stay");
  assert.equal(items.get("alignment:job-never").attention, false);
  assert.equal(items.get("alignment:job-never").state, "failed");
  assert.equal(activity.processes.find((process: any) => process.id === "alignment").counts.failed, 4, "the queue still lists every failed job");
  const stored = JSON.parse((sqlite.prepare("SELECT data FROM alignment_jobs WHERE id='job-gone'").get() as { data: string }).data);
  assert.equal(stored.status, "error", "the stored job is untouched");
});

test("with every failed job's book outside the library nothing calls for attention", async () => {
  await app.inject({ method: "DELETE", url: "/api/works/w-kept/library", cookies });
  const { activity } = await read();
  assert.equal(activity.attention, 0);
  assert.equal(activity.items.filter((item: any) => item.attention).length, 0);
  assert.equal(activity.items.filter((item: any) => item.kind === "alignment" && item.state === "failed").length, 4);
});

test("adding the book back makes a failure younger than seven days call for attention again", async () => {
  for (const work of ["gone", "old", "never"]) {
    const added = await app.inject({ method: "PUT", url: `/api/works/w-${work}/library`, cookies });
    assert.equal(added.statusCode, 200, added.body);
  }
  const { items, calling } = await read();
  assert.deepEqual(calling, ["alignment:job-gone", "alignment:job-never"]);
  assert.equal(items.get("alignment:job-old").attention, false, "an old failure stays quiet");
});
