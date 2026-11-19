/**
 * The series dialog went with #569, but a tab with an older build still has it open (spec #560, "Older clients"). Every
 * request it sent must keep its answer: the preview, save, ack, removal preview, delete with and without a body, the
 * series acquisition retry and the Completion select. The bodies below are the strings the dialog's `api()` sent
 * (`src/components/Series.tsx`, `SeriesRemoveDialog.tsx`, `SeriesWorkStatus.tsx` and `SeriesWorkSavedDetails.tsx` on
 * the revision before #569), with its `Content-Type: application/json`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-older-client-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { setSeriesAcquisitionDeps, resetSeriesAcquisitionDeps } = await import("../server/series-acquisition.ts");
const app = await createApp({ background: { manual: true } });
// The Hardcover token and book import the series and Discover code still needs (#721 part d; removed in part b/c2).
(await import("./hardcover-fixture-routes.ts")).registerHardcoverFixtureRoutes(app);
const originalFetch = globalThis.fetch;

const SERIES = 61;
type Entry = { position: number | null; id: number; title: string };
const entries: Entry[] = [
  { position: 1, id: 301, title: "Old Tab One" },
  { position: 2, id: 302, title: "Old Tab Two" },
  { position: null, id: 303, title: "Old Tab Companion" },
];
// Hardcover lists this one later: the saved series marks it New.
const later: Entry = { position: 3, id: 304, title: "Old Tab Three" };
let listed = [...entries];
const book = (entry: Entry) => ({
  id: entry.id, title: entry.title, slug: null, description: null,
  release_year: 2001, release_date: "2001-01-01", cached_image: null, users_count: 10,
  default_physical_edition: { language: { language: "en", code2: "en" } }, default_audio_edition: null, editions: [],
  contributions: [{ contribution: "author", author: { name: "Ola Tab" } }],
  book_series: [{ position: entry.position, series: { id: SERIES, name: "The Old Tab" } }],
});
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/")) throw new Error(`Unexpected external request: ${String(input)}`);
  const { query, variables } = JSON.parse(String(init?.body));
  if (query.includes("SonderSeriesPreview")) return Response.json({ data: { series_by_pk: {
    id: SERIES, name: "The Old Tab", books_count: listed.length, author: { name: "Ola Tab" },
    book_series: listed.map((entry) => ({ position: entry.position, book: book(entry) })),
  } } });
  if (query.includes("SonderBook(")) {
    const entry = [...entries, later].find((item) => item.id === variables.id);
    return Response.json({ data: { books_by_pk: entry ? book(entry) : null } });
  }
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};
// The ebook search of a retry finds nothing, without the network: the job is done.
setSeriesAcquisitionDeps({
  fetchEbooks: async () => ({ downloaded: [], skipped: null, failures: [] as string[] }),
  canAcquireMedia: () => true,
});
after(async () => {
  globalThis.fetch = originalFetch;
  resetSeriesAcquisitionDeps();
  await app.close();
  sqlite.close();
});

async function login(payload: Record<string, string>) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload });
  assert.equal(response.statusCode, 200, response.body);
  return response.cookies[0]!.value;
}
const owner = await login({ password: "admin-password" });
const created = await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: owner },
  payload: { username: "sam", password: "sam-password" } });
assert.equal(created.statusCode, 200, created.body);
const sam = await login({ username: "sam", password: "sam-password" });
for (const cookie of [owner, sam]) {
  const token = await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", cookies: { sonder_session: cookie }, payload: { token: "fixture-token" } });
  assert.equal(token.statusCode, 200, token.body);
}

/** One request as the dialog's `api()` sent it: a JSON string body with its JSON header, or none at all. */
async function send(cookie: string, method: "GET" | "POST" | "DELETE" | "PATCH", url: string, body?: string) {
  return app.inject({
    method, url, cookies: { sonder_session: cookie },
    ...(body === undefined ? {} : { payload: body, headers: { "content-type": "application/json" } }),
  });
}
async function ok(cookie: string, method: "GET" | "POST" | "DELETE" | "PATCH", url: string, body?: string) {
  const response = await send(cookie, method, url, body);
  assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
  return response.json();
}
type Work = { id: number; title: string; position: number | null; workId: string | null; added?: boolean; new?: boolean; owned?: boolean; selected?: boolean; unreleased: boolean; acquisition?: { ebook: { status: string } | null } | null };
type Series = { id: number; name: string; author: string | null; works: Work[]; completion?: { finished: number; total: number } };
const libraryTitles = async (cookie: string) =>
  new Set(((await ok(cookie, "GET", "/api/books")) as { title: string; inLibrary: boolean }[]).filter((item) => item.inLibrary).map((item) => item.title));
const savedIds = async (cookie: string) => ((await ok(cookie, "GET", "/api/series")) as { id: number }[]).map((item) => item.id);
// The dialog saved with the books it had chosen and its two checkboxes.
const saveBody = (bookIds: number[], searchEbooks = false) =>
  JSON.stringify({ id: SERIES, bookIds, searchAudio: false, searchEbooks });

test("the preview of a series that is not saved answers the dialog's request with the fields it read", async () => {
  const preview = (await ok(owner, "GET", `/api/hardcover/series/${SERIES}?language=${encodeURIComponent("en")}`)) as Series;
  assert.equal(preview.id, SERIES);
  assert.equal(preview.name, "The Old Tab");
  assert.equal(preview.author, "Ola Tab");
  assert.deepEqual(preview.works.map((work) => [work.id, work.position, work.unreleased, work.workId]),
    [[301, 1, false, null], [302, 2, false, null], [303, null, false, null]]);
});

test("save, read, ack: the saved series answers the dialog's requests", async () => {
  const saved = (await ok(owner, "POST", "/api/series", saveBody([301, 302]))) as Series;
  assert.equal(saved.id, SERIES);
  assert.deepEqual(saved.works.filter((work) => work.added).map((work) => work.id).sort(), [301, 302]);
  assert.ok((await libraryTitles(owner)).has("Old Tab One"));
  assert.deepEqual(await savedIds(owner), [SERIES]);
  // The dialog read the saved series with its language, and with refresh=1 for its Retry.
  const read = (await ok(owner, "GET", `/api/series/${SERIES}?language=en`)) as Series;
  assert.deepEqual(read.works.map((work) => work.id), [301, 302, 303]);
  assert.equal(typeof read.completion?.finished, "number");

  // Hardcover lists a book later: New on the next refresh, and the dialog's ack clears it.
  listed = [...entries, later];
  const refreshed = (await ok(owner, "GET", `/api/series/${SERIES}?language=en&refresh=1`)) as Series;
  assert.deepEqual(refreshed.works.filter((work) => work.new).map((work) => work.id), [304]);
  const acked = (await ok(owner, "POST", `/api/series/${SERIES}/ack`, JSON.stringify({ bookIds: [304] }))) as Series;
  assert.deepEqual(acked.works.filter((work) => work.new).map((work) => work.id), []);
  assert.deepEqual(((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).works.filter((work) => work.new), []);
});

test("the dialog's Retry of a failed series search runs it again", async () => {
  const workId = ((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).works.find((work) => work.id === 301)!.workId!;
  sqlite.prepare("DELETE FROM series_acquisition_jobs WHERE book_id = 301").run();
  db.insert(schema.seriesAcquisitionJobs).values({
    id: "older-client-ebook", userId: 1, seriesId: SERIES, bookId: 301, workId, kind: "ebook", status: "failed",
    error: "temporary", updatedAt: Date.now(),
  }).run();
  const before = ((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).works.find((work) => work.id === 301);
  assert.equal(before?.acquisition?.ebook?.status, "failed");
  await ok(owner, "POST", `/api/series/${SERIES}/works/301/acquisition/retry`, JSON.stringify({ kind: "ebook" }));
  const after = ((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).works.find((work) => work.id === 301);
  assert.equal(after?.acquisition?.ebook?.status, "done");
  // Another account cannot retry the owner's series search.
  const other = await send(sam, "POST", `/api/series/${SERIES}/works/301/acquisition/retry`, JSON.stringify({ kind: "ebook" }));
  assert.notEqual(other.statusCode, 200, other.body);
  const kept = ((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).works.find((work) => work.id === 301);
  assert.equal(kept?.acquisition?.ebook?.status, "done");
});

test("the dialog's Completion select still sets a work's completion", async () => {
  const work = ((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).works.find((item) => item.id === 301)!;
  await ok(owner, "PATCH", `/api/works/${encodeURIComponent(work.workId!)}/completion`, JSON.stringify({ status: "finished" }));
  assert.equal(((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).completion?.finished, 1);
  await ok(owner, "PATCH", `/api/works/${encodeURIComponent(work.workId!)}/completion`, JSON.stringify({ status: "derived" }));
  assert.equal(((await ok(owner, "GET", `/api/series/${SERIES}`)) as Series).completion?.finished, 0);
});

test("the removal preview and a delete with an empty body, with none and with books", async () => {
  type Removal = { id: number; name: string; works: { bookId: number; introduced: boolean; selectedByDefault: boolean; audioEditions: unknown[]; activeDownloads: unknown[]; otherSeries: unknown[] }[] };
  const removal = (await ok(owner, "GET", `/api/series/${SERIES}/removal`)) as Removal;
  assert.equal(removal.id, SERIES);
  assert.deepEqual(removal.works.map((work) => [work.bookId, work.introduced, work.selectedByDefault]).sort(),
    [[301, true, true], [302, true, true]]);
  // Another account sees nothing of the owner's removal: the series is not saved for it.
  const other = await send(sam, "GET", `/api/series/${SERIES}/removal`);
  if (other.statusCode === 200) assert.deepEqual((other.json() as Removal).works, []);

  // The switch off: the dialog sent `{}`. The series goes, its books stay.
  await ok(owner, "DELETE", `/api/series/${SERIES}`, "{}");
  assert.deepEqual(await savedIds(owner), []);
  assert.ok((await libraryTitles(owner)).has("Old Tab Two"));

  // No body at all, and a JSON header over an empty body: the same.
  await ok(owner, "POST", "/api/series", saveBody([301, 302]));
  await ok(owner, "DELETE", `/api/series/${SERIES}`);
  assert.deepEqual(await savedIds(owner), []);
  await ok(owner, "POST", "/api/series", saveBody([301, 302]));
  await ok(owner, "DELETE", `/api/series/${SERIES}`, "");
  assert.deepEqual(await savedIds(owner), []);
  assert.ok((await libraryTitles(owner)).has("Old Tab Two"));

  // Someone who is not the administrator: books with the series are refused, the series alone goes.
  await ok(sam, "POST", "/api/series", saveBody([303]));
  assert.ok((await libraryTitles(sam)).has("Old Tab Companion"));
  const refused = await send(sam, "DELETE", `/api/series/${SERIES}`, JSON.stringify({ bookIds: [303] }));
  assert.equal(refused.statusCode, 403, refused.body);
  assert.deepEqual(await savedIds(sam), [SERIES]);
  await ok(sam, "DELETE", `/api/series/${SERIES}`, "{}");
  assert.deepEqual(await savedIds(sam), []);
  assert.ok((await libraryTitles(sam)).has("Old Tab Companion"));

  // The administrator with the switch on and a book chosen: it leaves the library with the series.
  await ok(owner, "POST", "/api/series", saveBody([301, 302]));
  await ok(owner, "DELETE", `/api/series/${SERIES}`, JSON.stringify({ bookIds: [302] }));
  assert.deepEqual(await savedIds(owner), []);
  const titles = await libraryTitles(owner);
  assert.ok(!titles.has("Old Tab Two"));
  assert.ok(titles.has("Old Tab One"));
  // Sam's library is untouched by the owner's removal.
  assert.ok((await libraryTitles(sam)).has("Old Tab Companion"));
});
