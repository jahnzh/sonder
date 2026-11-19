// A second (non-admin) account may not search for or pick a release of a saved series' book (#205), on AudiobookDB's
// text ids (#721 part b). The series comes from the recorded answers (tests/audiobookdb-fixture.ts); the release
// sources are fakes that count their calls, so nothing reaches AudioBookBay, Prowlarr or a provider.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-release-auth-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });

const originalFetch = globalThis.fetch;
// Any request the fixtures do not answer is a defect in the test.
const refuse: typeof fetch = async (input) => {
  throw new Error(`Unexpected external request: ${String(input instanceof Request ? input.url : input)}`);
};
globalThis.fetch = refuse;
const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
const control = createControl();
const SERIES = "sr-test-saga";
const FIRST = "bk-first";
control.series.set(SERIES, {
  id: SERIES,
  name: "Test Saga",
  people: [{ name: "Ada Author", role: { name: "Author" } }],
  books: [seriesMember(FIRST, "First volume", "Ada Author", "1", 1, { releaseDate: "2020-01-01" })],
});
control.openLibrarySeries.set("test saga", []);
let now = Date.parse("2026-11-19T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control, refuse), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control, refuse), clock });

const { createApp } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { setSeriesReleaseSearchDeps, resetSeriesReleaseSearchDeps } = await import("../server/series-release-search.ts");
type SeriesReleaseSearchDeps = import("../server/series-release-search.ts").SeriesReleaseSearchDeps;
const calls: string[] = [];
const release = { id: "abb-first", title: "First volume M4B (admin queue)", source: "abb" as const, format: "M4B" };
setSeriesReleaseSearchDeps({
  abbReleaseSearch: (async () => {
    calls.push("abbReleaseSearch");
    return { results: [release], page: 1, nextPage: null };
  }) as unknown as SeriesReleaseSearchDeps["abbReleaseSearch"],
  prowlarrReleaseSearch: (async () => {
    calls.push("prowlarrReleaseSearch");
    return { results: [], page: 1, nextPage: null };
  }) as SeriesReleaseSearchDeps["prowlarrReleaseSearch"],
  abbRelease: (async () => {
    calls.push("abbRelease");
    throw new Error("abbRelease must not run");
  }) as SeriesReleaseSearchDeps["abbRelease"],
  abbMagnet: async () => {
    calls.push("abbMagnet");
    throw new Error("abbMagnet must not run");
  },
  acquire: (async () => {
    calls.push("acquire");
    throw new Error("acquire must not run");
  }) as SeriesReleaseSearchDeps["acquire"],
});
// The series loop never ticks on its own here.
const app = await createApp({ background: { manual: ["series-acquisition"] } });
// The Hardcover token and book import the series and Discover code still needs (#721 part d; removed in part b/c2).
(await import("./hardcover-fixture-routes.ts")).registerHardcoverFixtureRoutes(app);

after(async () => {
  globalThis.fetch = originalFetch;
  resetSeriesReleaseSearchDeps();
  await app.close();
});

const login = async (username: string | undefined, password: string) => {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};

test("non-admin session is refused on both release routes", async () => {
  const adminCookie = await login(undefined, "admin-password");
  const adminSaved = await app.inject({
    method: "POST",
    url: "/api/series",
    cookies: { sonder_session: adminCookie },
    payload: { id: SERIES, bookIds: [FIRST] },
  });
  assert.equal(adminSaved.statusCode, 200, adminSaved.body);
  // The admin's own search works: the release is in the admin's search results.
  const adminSearch = await app.inject({
    url: `/api/series/${SERIES}/works/${FIRST}/releases/search?q=First`,
    cookies: { sonder_session: adminCookie },
  });
  assert.equal(adminSearch.statusCode, 200, adminSearch.body);
  assert.equal(adminSearch.json().results.length, 1);
  calls.length = 0;

  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    cookies: { sonder_session: adminCookie },
    payload: { username: "reader", password: "password1" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const userCookie = await login("reader", "password1");
  // The reader saves the same series, so the refusal is about the role, not a series they lack.
  const readerSaved = await app.inject({
    method: "POST",
    url: "/api/series",
    cookies: { sonder_session: userCookie },
    payload: { id: SERIES, bookIds: [FIRST] },
  });
  assert.equal(readerSaved.statusCode, 200, readerSaved.body);

  const search = await app.inject({
    url: `/api/series/${SERIES}/works/${FIRST}/releases/search?q=First`,
    cookies: { sonder_session: userCookie },
  });
  assert.equal(search.statusCode, 403, search.body);
  assert.doesNotMatch(search.body, /admin queue|abb-first/);
  const select = await app.inject({
    method: "POST",
    url: `/api/series/${SERIES}/works/${FIRST}/releases/select`,
    cookies: { sonder_session: userCookie },
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(select.statusCode, 403, select.body);
  assert.doesNotMatch(select.body, /admin queue/);
  // An older client's numeric ids are refused the same way.
  const numeric = await app.inject({
    url: "/api/series/31/works/201/releases/search?q=First",
    cookies: { sonder_session: userCookie },
  });
  assert.equal(numeric.statusCode, 403, numeric.body);
  // No source was asked and nothing was queued for the reader.
  assert.deepEqual(calls, []);
  assert.equal(db.select().from(schema.acquisitions).all().length, 0);
  assert.equal(db.select().from(schema.userAcquisitions).all().length, 0);
});
