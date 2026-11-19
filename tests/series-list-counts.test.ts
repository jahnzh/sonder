/**
 * `GET /api/series` gains `finished`, `total` and `covers` per saved series (#561), from the
 * book-per-number rule in `src/series-selection.ts`, with each user's own library.
 *
 * `tests/fixtures/series-routes-pin.json` holds every other field of `GET /api/series`,
 * `GET /api/series/<id>` and `GET /api/hardcover/series/<id>` for this fixture, recorded on the
 * revision before #561. Never rewrite it to make this test pass; rewrite it only for an intended
 * change to those routes, with `SONDER_UPDATE_SERIES_PIN=1 npx tsx --test tests/series-list-counts.test.ts`,
 * and review the diff.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-list-counts-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp({ background: { manual: true } });
// The Hardcover token and book import the series and Discover code still needs (#721 part d; removed in part b/c2).
(await import("./hardcover-fixture-routes.ts")).registerHardcoverFixtureRoutes(app);
const originalFetch = globalThis.fetch;

const SERIES = 51;
const cover = (id: number) => `https://covers.test/${id}.jpg`;
// Hardcover lists the French translations at the same number as the originals.
const entries: { position: number | null; id: number; title: string; date: string; language: string }[] = [
  { position: 1, id: 201, title: "The First Tide", date: "2001-01-01", language: "en" },
  { position: 1, id: 211, title: "La Première Marée", date: "2003-01-01", language: "fr" },
  { position: 2, id: 202, title: "The Second Tide", date: "2002-01-01", language: "en" },
  { position: 2, id: 212, title: "La Deuxième Marée", date: "2004-01-01", language: "fr" },
  { position: 3, id: 203, title: "The Third Tide", date: "2005-01-01", language: "en" },
  { position: 4, id: 204, title: "The Last Tide", date: "2999-01-01", language: "en" },
  { position: null, id: 205, title: "Tide Charts", date: "2006-01-01", language: "en" },
];
const books = entries.map((entry) => ({
  id: entry.id, title: entry.title, slug: null, description: null,
  release_year: Number(entry.date.slice(0, 4)), release_date: entry.date,
  cached_image: { url: cover(entry.id) }, users_count: 10,
  default_physical_edition: { language: { language: entry.language, code2: entry.language } },
  default_audio_edition: null, editions: [],
  contributions: [{ contribution: "author", author: { name: "Mara Coast" } }],
  book_series: [{ position: entry.position, series: { id: SERIES, name: "The Tides" } }],
}));
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/")) throw new Error(`Unexpected external request: ${String(input)}`);
  const { query, variables } = JSON.parse(String(init?.body));
  if (query.includes("SonderSeriesPreview")) return Response.json({ data: { series_by_pk: {
    id: SERIES, name: "The Tides", books_count: entries.length, author: { name: "Mara Coast" },
    book_series: entries.map((entry) => ({ position: entry.position, book: books.find((book) => book.id === entry.id) })),
  } } });
  if (query.includes("SonderBook(")) return Response.json({ data: { books_by_pk: books.find((book) => book.id === variables.id) ?? null } });
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};
after(async () => {
  globalThis.fetch = originalFetch;
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

async function get(cookie: string, url: string) {
  const response = await app.inject({ url, cookies: { sonder_session: cookie } });
  assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
  return response.json();
}
async function save(cookie: string, bookIds: number[]) {
  const token = await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", cookies: { sonder_session: cookie }, payload: { token: "fixture-token" } });
  assert.equal(token.statusCode, 200, token.body);
  const response = await app.inject({ method: "POST", url: "/api/series", cookies: { sonder_session: cookie }, payload: { id: SERIES, bookIds } });
  assert.equal(response.statusCode, 200, response.body);
}
async function finish(cookie: string, bookId: number) {
  const work = (await get(cookie, `/api/series/${SERIES}`)).works.find((item: { id: number }) => item.id === bookId);
  assert.ok(work?.editionId, `book ${bookId} is in the library`);
  const response = await app.inject({ method: "PATCH", url: `/api/library/${work.editionId}`, cookies: { sonder_session: cookie }, payload: { status: "finished" } });
  assert.equal(response.statusCode, 200, response.body);
}
const counts = (item: { finished: number; total: number; covers: (string | null)[] }) =>
  ({ finished: item.finished, total: item.total, covers: item.covers });

// The owner holds number 1 (finished), the French translation at number 2 (unfinished) and the
// related work (finished). Number 3 is missing and released; number 4 is not released yet.
await save(owner, [201, 212, 205]);
await finish(owner, 201);
await finish(owner, 205);
const samBefore = await get(sam, "/api/series");
// Sam holds only number 3, finished.
await save(sam, [203]);
await finish(sam, 203);

// Runs first, before the tests below change any place.
const PIN = new URL("./fixtures/series-routes-pin.json", import.meta.url);
/** Ids and times that differ between runs become their order of appearance. */
function stable(value: unknown) {
  const labels = new Map<string, string>();
  const label = (raw: string) => {
    if (!labels.has(raw)) labels.set(raw, `<id ${labels.size + 1}>`);
    return labels.get(raw)!;
  };
  const visit = (node: unknown, key = ""): unknown => {
    if (Array.isArray(node)) return node.map((item) => visit(item, key));
    if (node && typeof node === "object")
      return Object.fromEntries(Object.entries(node).map(([name, child]) => [name, visit(child, name)]));
    if (typeof node === "number" && /At$/.test(key)) return "<time>";
    if (typeof node === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(node)) return label(node);
    if (typeof node === "string" && /(^|[-:])[0-9a-f]{8}-[0-9a-f]{4}-/i.test(node))
      return node.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => label(id));
    return node;
  };
  return visit(value);
}

test("every other field of the series routes is unchanged for the same fixture", async () => {
  const bodies: Record<string, unknown> = {};
  for (const [user, cookie] of [["owner", owner], ["sam", sam]] as const) {
    const list = await get(cookie, "/api/series");
    for (const item of list) {
      // The new fields (#561); everything else must be as before.
      assert.deepEqual(Object.keys(item).filter((key) => !["id", "name", "author", "count"].includes(key)).sort(),
        process.env.SONDER_UPDATE_SERIES_PIN === "1" ? Object.keys(item).filter((key) => !["id", "name", "author", "count"].includes(key)).sort() : ["covers", "finished", "total"]);
      delete item.finished; delete item.total; delete item.covers;
    }
    bodies[`${user} GET /api/series`] = list;
    bodies[`${user} GET /api/series/${SERIES}`] = await get(cookie, `/api/series/${SERIES}`);
    bodies[`${user} GET /api/series/${SERIES}?language=fr`] = await get(cookie, `/api/series/${SERIES}?language=fr`);
    bodies[`${user} GET /api/hardcover/series/${SERIES}`] = await get(cookie, `/api/hardcover/series/${SERIES}`);
    bodies[`${user} GET /api/hardcover/series/${SERIES}?language=fr`] = await get(cookie, `/api/hardcover/series/${SERIES}?language=fr`);
  }
  const actual = stable(bodies);
  if (process.env.SONDER_UPDATE_SERIES_PIN === "1") writeFileSync(PIN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(readFileSync(PIN, "utf8")));
});

test("GET /api/series counts the numbers whose book is held or released, and the finished ones", async () => {
  const [series] = await get(owner, "/api/series");
  assert.deepEqual(counts(series), {
    finished: 1, total: 3,
    // The book at number 2 is the translation in the library, not the English original.
    covers: [cover(201), cover(212), cover(203)],
  });
});

test("GET /api/series gives a second user counts and covers from their own library only", async () => {
  assert.deepEqual(samBefore, [], "nothing is listed before the second user saves the series");
  const [series] = await get(sam, "/api/series");
  assert.deepEqual(counts(series), {
    finished: 1, total: 3,
    // The owner's French book at number 2 does not stand there for Sam: the English original does.
    covers: [cover(201), cover(202), cover(203)],
  });
  await finish(owner, 212);
  assert.deepEqual(counts((await get(owner, "/api/series"))[0]), { finished: 2, total: 3, covers: [cover(201), cover(212), cover(203)] });
  assert.deepEqual(counts((await get(sam, "/api/series"))[0]), counts(series), "the owner finishing a book leaves Sam's counts alone");
  const status = await app.inject({ method: "PATCH", url: `/api/library/${(await get(owner, `/api/series/${SERIES}`)).works.find((item: { id: number }) => item.id === 212).editionId}`,
    cookies: { sonder_session: owner }, payload: { status: "unread" } });
  assert.equal(status.statusCode, 200, status.body);
});
