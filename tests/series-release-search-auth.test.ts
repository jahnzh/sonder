import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "sonder-series-release-auth-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.hardcover.app/")) {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("SonderSeriesPreview"))
      return Response.json({
        data: {
          series_by_pk: {
            id: 31,
            name: "Test Saga",
            books_count: 1,
            author: { name: "Ada Author" },
            book_series: [
              {
                position: 1,
                book: {
                  id: 201,
                  title: "First volume",
                  release_year: 2020,
                  release_date: "2020-01-01",
                  slug: null,
                  cached_image: null,
                  contributions: [
                    { contribution: "author", author: { name: "Ada Author" } },
                  ],
                },
              },
            ],
          },
        },
      });
    if (query.includes("SonderBook("))
      return Response.json({
        data: {
          books_by_pk: {
            id: 201,
            title: "First volume",
            slug: null,
            cached_image: null,
            contributions: [
              { contribution: "author", author: { name: "Ada Author" } },
            ],
            editions: [],
          },
        },
      });
    return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
  }
  throw new Error(`Unexpected external request: ${url}`);
};

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
// The series loop never ticks on its own here.
const app = await createApp({ background: { manual: ["series-acquisition"] } });
// The Hardcover token and book import the series and Discover code still needs (#721 part d; removed in part b/c2).
(await import("./hardcover-fixture-routes.ts")).registerHardcoverFixtureRoutes(app);

after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  rmSync(temp, { recursive: true, force: true });
});

test("non-admin session is refused on both release routes", async () => {
  const adminCookie = (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "admin-password" },
    })
  ).cookies[0].value;
  await app.inject({
    method: "PUT",
    url: "/api/__fixture/hardcover-token",
    cookies: { sonder_session: adminCookie },
    payload: { token: "fixture-token" },
  });
  await app.inject({
    method: "POST",
    url: "/api/series",
    cookies: { sonder_session: adminCookie },
    payload: { id: 31, bookIds: [201] },
  });
  await app.inject({
    method: "POST",
    url: "/api/users",
    cookies: { sonder_session: adminCookie },
    payload: { username: "reader", password: "password1" },
  });
  const userCookie = (
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "reader", password: "password1" },
    })
  ).cookies[0].value;
  const search = await app.inject({
    url: "/api/series/31/works/201/releases/search?q=First",
    cookies: { sonder_session: userCookie },
  });
  assert.equal(search.statusCode, 403, search.body);
  const select = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    cookies: { sonder_session: userCookie },
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(select.statusCode, 403, select.body);
  assert.equal(db.select().from(schema.acquisitions).all().length, 0);
});
