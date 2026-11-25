// The shadow libraries besides the libgen.li family (#901), with what each answered on 2026-11-25: Anna's Archive's
// redirect to its browser check, DDoS-Guard's 403 and the fast-download API's refusal of a bad key; Z-Library's
// refused login, its profile without a session and DiamWall's 513 check; and the libgen.rs family's results page as the
// Wayback Machine kept it (2025-02-02; the sites did not answer). The key below is a made-up one; no account is used.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-shadow-libraries-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { parseLibgenRsSearch } = await import("../server/sources/libgen-rs-parse.ts");
const { parseSearchPage: parseAnnas } = await import("../server/sources/annas-archive-parse.ts");
const shadow = await import("../server/sources/shadow-libraries.ts");
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { isSourceReachFailure } = await import("../server/series-acquisition.ts");

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const RS_SEARCH = fixture("libgen-rs-search.html");
const ANNAS_REDIRECT = fixture("annas-search-redirect.html");
const ANNAS_CHECK_PAGE = fixture("annas-ddos-guard-403.html");
const ANNAS_BAD_KEY = fixture("annas-fast-download-invalid-key.json");
const ZLIB_LOGIN_REFUSED = fixture("zlib-login-refused.json");
const ZLIB_LOGGED_OUT = fixture("zlib-profile-logged-out.json");
const ZLIB_WALL = fixture("zlib-diamwall-513.html");
const LIBGEN_ADS = fixture("libgen-ads.html");

const app = await createApp({ background: { manual: ["acquisitions", "series-acquisition"] } });
const original = globalThis.fetch;
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler = (url) => {
  throw new Error(`Unexpected request: ${url}`);
};
const asked: { url: string; init?: RequestInit }[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  asked.push({ url: url.href, init });
  return handler(url, init);
};
beforeEach(() => {
  asked.length = 0;
});
after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
});
const settings = (body: Record<string, string>) => app.inject({ method: "PATCH", url: "/api/settings", payload: body });
const FAKE_KEY = "made-up-test-key-0000";

test("the libgen.rs family's recorded page: its rows, the title without its ISBNs, the authors, an EPUB or PDF of them", () => {
  const files = parseLibgenRsSearch(RS_SEARCH);
  assert.equal(files.length, 25);
  assert.deepEqual(files[1], {
    md5: "61774e85e6d6e4fb852614917cc2cbf3",
    title: "Especes d'espaces",
    authors: ["Georges Perec"],
    publisher: "Galilée",
    year: "1985",
    language: "French",
    size: "2 Mb",
    extension: "djvu",
  });
  // Three authors, each a link of its own.
  assert.deepEqual(files[2].authors, ["Pierre Lusson", "Georges Perec", "Jacques Roubaud"]);
  assert.equal(files.filter((file) => file.extension === "epub").length, 3);
  assert.equal(files.filter((file) => file.extension === "pdf").length, 11);
  // A page without its table (the libgen.li family's, a parked domain) lists nothing.
  assert.deepEqual(parseLibgenRsSearch(fixture("libgen-search.html")), []);
});

test("a libgen.rs search lists its EPUBs and PDFs; Get this edition fetches it by md5 through the libgen.li family", async () => {
  db.insert(s.works).values({ id: "work-perec", title: "La Vie mode d'emploi", author: "Georges Perec", description: "", genre: "", year: 1978 }).run();
  const file = parseLibgenRsSearch(RS_SEARCH).find((entry) => entry.extension === "epub")!;
  const content = Buffer.from(`PK\x03\x04 ${file.title}`);
  const md5 = createHash("md5").update(content).digest("hex");
  handler = (url) => {
    if (url.hostname === "libgen.is") return new Response(RS_SEARCH);
    // The file of that md5 on the libgen.li family (the recorded page, its link pointed at this file).
    if (url.pathname === "/ads.php") return new Response(LIBGEN_ADS.replaceAll("57cde5f547cb9eff0233238bc6d92a8e", md5));
    if (url.pathname === "/get.php") return new Response(new Uint8Array(content), { headers: { "Content-Length": String(content.length) } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const search = await app.inject("/api/discover/ebooks?source=libgenrs&q=georges+perec");
  assert.equal(search.statusCode, 200, search.body);
  const files = search.json().files;
  assert.equal(files.length, 14);
  assert.equal(files[0].source, "libgenrs");
  assert.equal(files[0].url, `https://libgen.is/book/index.php?md5=${files[0].md5}`);
  assert.equal(new URL(asked[0].url).searchParams.get("req"), "georges perec");
  const epub = files.find((entry: { extension: string }) => entry.extension === "epub");
  assert.equal(epub.title, file.title);
  const saved = await app.inject({ method: "POST", url: "/api/ebooks", payload: { ...epub, md5, workId: "work-perec" } });
  assert.equal(saved.statusCode, 200, saved.body);
  // Kept as the libgen.li family's file of that md5.
  assert.equal(saved.json().id, `libgen-${md5}`);
  assert.equal(db.select().from(s.ebookEditions).where(eq(s.ebookEditions.id, `libgen-${md5}`)).get()?.workId, "work-perec");
  assert.ok(asked.some((entry) => new URL(entry.url).hostname === "libgen.li" && entry.url.includes("/ads.php")));
});

test("the libgen.rs family out of reach: its own reach failure, which the series queue tries again", async () => {
  handler = () => Promise.reject(new TypeError("fetch failed"));
  const search = await app.inject("/api/discover/ebooks?source=libgenrs&q=perec");
  assert.equal(search.statusCode, 400);
  assert.equal(search.json().error, "Library Genesis (libgen.rs) could not be reached.");
  assert.ok(isSourceReachFailure(search.json().error));
});

test("Anna's Archive: the key and address are saved in Settings, encrypted, and only whether a key is saved is answered", async () => {
  assert.equal((await settings({ annasUrl: "http://annas-archive.gl" })).statusCode, 400);
  assert.equal((await settings({ annasUrl: "https://evil.example" })).statusCode, 400);
  assert.equal((await settings({ annasUrl: "https://annas-archive.gl/x", annas: FAKE_KEY })).statusCode, 200);
  const stored = db.select().from(s.settings).where(eq(s.settings.key, "annas")).get()!;
  assert.notEqual(stored.value, FAKE_KEY);
  const read = (await app.inject("/api/settings")).json();
  assert.equal(read.annasConfigured, true);
  assert.equal(read.annasUrl, "https://annas-archive.gl");
  assert.doesNotMatch(JSON.stringify(read), new RegExp(FAKE_KEY));
});

test("Anna's Archive asking for browser verification is said plainly and not retried; the key never leaves in a message", async () => {
  let logins = 0;
  handler = (url, init) => {
    if (url.pathname === "/account/") {
      logins++;
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { Location: "/account/", "Set-Cookie": `aa_account_id2=session-${logins}; HttpOnly` } });
    }
    if (url.pathname === "/search" && !url.searchParams.has("check"))
      return new Response(ANNAS_REDIRECT, { status: 302, headers: { Location: `${url.pathname}${url.search}&check=1` } });
    return new Response(ANNAS_CHECK_PAGE, { status: 403, headers: { "Content-Type": "text/html" } });
  };
  const search = await app.inject("/api/discover/ebooks?source=annas&q=dungeon+crawler+carl");
  assert.equal(search.statusCode, 502, search.body);
  assert.equal(search.json().error, shadow.ANNAS_CHECK);
  assert.equal(search.json().code, "source_verification");
  // Signed in with its cookie; the redirect to the check was not followed, and not tried again after waits.
  const searches = asked.filter((entry) => entry.url.includes("/search"));
  assert.equal(searches.length, 1);
  assert.equal(new Headers(searches[0].init?.headers).get("Cookie"), "aa_account_id2=session-1");
  assert.deepEqual(new URL(searches[0].url).searchParams.getAll("ext"), ["epub", "pdf"]);
  // A cached session asked again is renewed once before the check is believed.
  asked.length = 0;
  const again = await app.inject("/api/discover/ebooks?source=annas&q=carl");
  assert.equal(again.json().error, shadow.ANNAS_CHECK);
  assert.equal(logins, 2);
  assert.doesNotMatch(search.body + again.body, new RegExp(FAKE_KEY));
  // Settings' check says the same.
  const checked = await app.inject({ method: "POST", url: "/api/annas/test" });
  assert.equal(checked.json().error, shadow.ANNAS_CHECK);
});

test("Anna's Archive refusing the key: at sign-in (no session cookie) and at the fast download (401 Invalid secret key)", async () => {
  handler = (url) => {
    if (url.pathname === "/account/") return new Response("<title>Log in / Register</title>", { status: 200 });
    if (url.pathname === "/dyn/api/fast_download.json")
      return new Response(ANNAS_BAD_KEY, { status: 401, headers: { "Content-Type": "text/json" } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const checked = await app.inject({ method: "POST", url: "/api/annas/test" });
  assert.equal(checked.json().error, "Anna’s Archive refused the key in Settings.");
  db.insert(s.works).values({ id: "work-dcc", title: "Dungeon Crawler Carl", author: "Matt Dinniman", description: "", genre: "", year: 2020 }).run();
  const md5 = "7a72d22ff9b6696e90ad924e42db2d12";
  const saved = await app.inject({
    method: "POST",
    url: "/api/ebooks",
    payload: { md5, source: "annas", title: "Dungeon Crawler Carl", authors: ["Matt Dinniman"], extension: "epub", language: "English", size: "2 MB", year: "2020", coverUrl: null, url: `https://annas-archive.gl/md5/${md5}`, workId: "work-dcc" },
  });
  assert.equal(saved.statusCode, 400);
  assert.equal(saved.json().error, shadow.ANNAS_REFUSED);
  // The key went in the API's query, and nowhere in the answer.
  assert.equal(new URL(asked.find((entry) => entry.url.includes("fast_download"))!.url).searchParams.get("key"), FAKE_KEY);
  assert.doesNotMatch(saved.body, new RegExp(FAKE_KEY));
});

test("Anna's Archive limiting requests rests as Library Genesis does", async () => {
  handler = () => new Response("Too many requests", { status: 429 });
  const search = await app.inject("/api/discover/ebooks?source=annas&q=carl");
  assert.equal(search.statusCode, 503);
  assert.equal(search.json().error, "Anna’s Archive is limiting requests.");
  assert.equal(search.json().code, "source_limited");
  assert.ok(isSourceReachFailure(search.json().error));
});

test("Anna's Archive's search page, as the restored parser reads it (its test from before #8)", () => {
  const md5 = "a".repeat(32);
  const files = parseAnnas(
    `<section><article><img src="/cover.jpg"/><a class="js-vim-focus" href="/md5/${md5}">A test title</a><a><span class="user-edit">Ada Author</span></a><div>English [en] · EPUB · 0.5MB · 2021 · Book</div></article><article><a class="js-vim-focus" href="/md5/${"b".repeat(32)}">Another title</a></article></section>`,
    "https://annas-archive.gl",
  );
  assert.equal(files[0].md5, md5);
  assert.equal(files[0].title, "A test title");
  assert.deepEqual(files[0].authors, ["Ada Author"]);
  assert.equal(files[0].extension, "epub");
  assert.equal(files[0].language, "English");
  assert.equal(files[0].coverUrl, "https://annas-archive.gl/cover.jpg");
});

test("Z-Library's account in Settings: encrypted, a token in either form, a bad token or address refused", async () => {
  assert.deepEqual(shadow.parseZlibToken("remix_userid=123; remix_userkey=abc9f"), { userId: "123", userKey: "abc9f" });
  assert.deepEqual(shadow.parseZlibToken("123:abc9f"), { userId: "123", userKey: "abc9f" });
  assert.equal(shadow.parseZlibToken("not a token"), null);
  assert.equal((await settings({ zlibToken: "not a token" })).statusCode, 400);
  assert.equal((await settings({ zlibUrl: "https://example.com" })).statusCode, 400);
  assert.equal((await app.inject("/api/settings")).json().zlibConfigured, false);
  assert.equal((await settings({ zlibUrl: "https://z-library.sk/", zlibEmail: "reader@example.invalid", zlibPassword: "made-up" })).statusCode, 200);
  for (const key of ["zlibEmail", "zlibPassword"])
    assert.doesNotMatch(db.select().from(s.settings).where(eq(s.settings.key, key)).get()!.value, /reader@|made-up/);
  const read = (await app.inject("/api/settings")).json();
  assert.equal(read.zlibConfigured, true);
  assert.equal(read.zlibUrl, "https://z-library.sk");
  assert.doesNotMatch(JSON.stringify(read), /reader@|made-up/);
  // A book page of the address in Settings names the book; another site's does not.
  assert.deepEqual(shadow.zlibBook("https://z-library.sk/book/1234/abcdef/a-title.html"), { id: "1234", hash: "abcdef" });
  assert.equal(shadow.zlibBook("https://evil.example/book/1234/abcdef"), null);
  assert.equal(shadow.zlibLimitLine({ used: 3, limit: 10 }), "3 of 10 downloads today.");
});

test("Z-Library refusing the login, and asking for browser verification, are said plainly", async () => {
  handler = (url) => {
    if (url.pathname === "/eapi/user/login") return new Response(ZLIB_LOGIN_REFUSED, { status: 400, headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const checked = await app.inject({ method: "POST", url: "/api/zlib/test" });
  assert.equal(checked.json().error, shadow.ZLIB_REFUSED);
  const search = await app.inject("/api/discover/ebooks?source=zlib&q=carl");
  assert.equal(search.json().error, "Z-Library refused the login in Settings.");
  // Signed in with the email and password, as a form.
  const login = asked.find((entry) => entry.url.endsWith("/eapi/user/login"))!;
  assert.equal(String(login.init?.body), new URLSearchParams({ email: "reader@example.invalid", password: "made-up" }).toString());
  // A remember-me token needs no sign-in; DiamWall's check stops the search with its own sentence.
  await settings({ zlibToken: "123:abc9f" });
  handler = (url) => {
    if (url.pathname === "/eapi/user/profile") return new Response(ZLIB_LOGGED_OUT, { status: 400, headers: { "Content-Type": "application/json" } });
    return new Response(ZLIB_WALL, { status: 513, headers: { "Content-Type": "text/html" } });
  };
  asked.length = 0;
  const walled = await app.inject("/api/discover/ebooks?source=zlib&q=carl");
  assert.equal(walled.statusCode, 502);
  assert.equal(walled.json().error, shadow.ZLIB_CHECK);
  assert.equal(new Headers(asked[0].init?.headers).get("Cookie"), "remix_userid=123; remix_userkey=abc9f");
  assert.ok(!asked.some((entry) => entry.url.includes("/eapi/user/login")));
  // The profile without a session: the login is refused.
  const profile = await app.inject({ method: "POST", url: "/api/zlib/test" });
  assert.equal(profile.json().error, shadow.ZLIB_REFUSED);
});
