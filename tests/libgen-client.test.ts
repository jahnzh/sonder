// The Library Genesis client (#901): requests one at a time and spaced by page kind, a limiting answer retried after
// growing waits and then on the next mirror, a kind of page resting after a request limited on every try, and each
// failure logged once with the mirror, the page kind and the status. The 500 is the one the download pages answered
// on 2026-11-25 (tests/fixtures/libgen-ads-500.html), the search page the one libgen.li answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createLibgenClient,
  isLibgenLimited,
  LIBGEN_LIMITED,
  LIBGEN_MIRRORS,
  LIBGEN_TIMING,
  LIBGEN_UNREACHABLE,
  LibgenLimitedError,
  type LibgenTiming,
} from "../server/sources/libgen-client.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const OVERLOADED = fixture("libgen-ads-500.html");
const ADS = fixture("libgen-ads.html");
const SEARCH = fixture("libgen-search.html");

const timing: LibgenTiming = { spacing: { search: 2_000, download: 6_000 }, waits: [4_000, 12_000], mirrorsPerRequest: 2, rests: [120_000, 300_000] };

/** A fake clock that moves when the client sleeps, and the requests it made with their times. */
function harness(answer: (url: string, n: number) => Response | Error, mirror: string | null = "https://libgen.li") {
  let clock = 1_000_000;
  const asked: { url: string; at: number }[] = [];
  const slept: number[] = [];
  const lines: string[] = [];
  const client = createLibgenClient({
    fetch: async (url) => {
      asked.push({ url, at: clock });
      const value = answer(url, asked.length);
      if (value instanceof Error) throw value;
      return value;
    },
    mirror: () => mirror,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    log: (line) => lines.push(line),
    timing,
  });
  return { client, asked, slept, lines, advance: (ms: number) => (clock += ms), now: () => clock };
}

test("the built-in mirrors are the libgen.li family, the one in Settings first and none twice", () => {
  assert.deepEqual([...LIBGEN_MIRRORS], ["https://libgen.li", "https://libgen.la", "https://libgen.gl", "https://libgen.vg", "https://libgen.bz"]);
  assert.deepEqual(harness(() => new Response("")).client.mirrors(), [...LIBGEN_MIRRORS]);
  assert.deepEqual(harness(() => new Response(""), "https://libgen.bz/").client.mirrors(), [
    "https://libgen.bz", "https://libgen.li", "https://libgen.la", "https://libgen.gl", "https://libgen.vg",
  ]);
  // The download pages are spaced more than the search page; the real waits grow.
  assert.ok(LIBGEN_TIMING.spacing.download > LIBGEN_TIMING.spacing.search);
  assert.ok(LIBGEN_TIMING.waits[1] > LIBGEN_TIMING.waits[0]);
});

test("requests go one at a time, each started the kind's spacing after the one before", async () => {
  const h = harness((url) => new Response(url.includes("ads.php") ? ADS : SEARCH));
  await Promise.all([
    h.client.request("search", "index.php?req=a"),
    h.client.request("download", "ads.php?md5=1"),
    h.client.request("download", "ads.php?md5=2"),
    h.client.request("search", "index.php?req=b"),
  ]);
  const gaps = h.asked.slice(1).map((entry, index) => entry.at - h.asked[index].at);
  assert.deepEqual(gaps, [6_000, 6_000, 2_000]);
  assert.deepEqual(h.lines, []);
});

test("a 500 is tried again after growing waits, then on the next mirror; each failure logged once", async () => {
  const h = harness((url, n) =>
    n <= 4 ? new Response(OVERLOADED, { status: 500 }) : new Response(ADS),
  );
  const { body, mirror } = await h.client.request("download", "ads.php?md5=57cde5f547cb9eff0233238bc6d92a8e");
  assert.equal(mirror, "https://libgen.la");
  assert.match(body!, /get\.php\?md5=57cde5f547cb9eff0233238bc6d92a8e/);
  assert.deepEqual(h.asked.map((entry) => new URL(entry.url).host), ["libgen.li", "libgen.li", "libgen.li", "libgen.la", "libgen.la"]);
  // The waits grow on each mirror (4 s, then 12 s) and are never shorter than the download pages' spacing (6 s).
  const gaps = h.asked.slice(1).map((entry, index) => entry.at - h.asked[index].at);
  assert.deepEqual(gaps, [6_000, 12_000, 6_000, 6_000]);
  assert.deepEqual(h.lines, [
    "Library Genesis: libgen.li download page answered 500 (limited), try 1",
    "Library Genesis: libgen.li download page answered 500 (limited), try 2",
    "Library Genesis: libgen.li download page answered 500 (limited), try 3",
    "Library Genesis: libgen.la download page answered 500 (limited), try 1",
  ]);
});

test("limited on every try: the kind of page rests, its requests fail at once with the time; the search page does not", async () => {
  let limit = true;
  const h = harness((url) => (url.includes("ads.php") && limit ? new Response(OVERLOADED, { status: 500 }) : new Response(url.includes("ads.php") ? ADS : SEARCH)));
  const error = await h.client.request("download", "ads.php?md5=1").then(
    () => assert.fail("expected a limited request"),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof LibgenLimitedError);
  assert.equal(error.message, LIBGEN_LIMITED);
  assert.equal(error.message, "Library Genesis is limiting requests.");
  assert.ok(isLibgenLimited(error.message));
  assert.equal(error.code, "source_limited");
  assert.equal(error.statusCode, 503);
  assert.equal(error.retryAt, h.now() + 120_000);
  assert.equal(error.retryAfterMs, 120_000);
  assert.equal(h.asked.length, 6);
  assert.match(h.lines.at(-1)!, /^Library Genesis: download pages limited on every try; next try at /);
  // While it rests, nothing is asked; the search page is not resting.
  limit = false;
  await assert.rejects(h.client.request("download", "ads.php?md5=2"), (failure: unknown) => failure instanceof LibgenLimitedError && failure.retryAt === error.retryAt);
  assert.equal(h.asked.length, 6);
  await h.client.request("search", "index.php?req=a");
  assert.equal(h.client.restingUntil("search"), 0);
  assert.equal(h.client.restingUntil("download"), error.retryAt);
  // After the rest it is asked again; a success ends the rests.
  h.advance(120_000);
  await h.client.request("download", "ads.php?md5=3");
  assert.equal(h.client.restingUntil("download"), 0);
});

test("the rest grows with each limited request in a row", async () => {
  const h = harness(() => new Response(OVERLOADED, { status: 500 }));
  const first = (await h.client.request("download", "ads.php?md5=1").catch((e) => e)) as LibgenLimitedError;
  h.advance(120_000);
  const second = (await h.client.request("download", "ads.php?md5=1").catch((e) => e)) as LibgenLimitedError;
  assert.equal(first.retryAfterMs, 120_000);
  assert.equal(second.retryAfterMs, 300_000);
});

test("a 429 and a verification page are limiting; a 404 is final; the web server's own page moves on to the next mirror", async () => {
  for (const answer of [
    new Response("slow down", { status: 429 }),
    new Response("<html><head><title>Just a moment...</title></head></html>", { status: 403 }),
    new Response("<html><head><title>Just a moment...</title></head></html>", { status: 200 }),
  ]) {
    const h = harness(() => answer.clone());
    await assert.rejects(h.client.request("search", "index.php?req=a"), LibgenLimitedError);
  }
  const missing = harness(() => new Response("no", { status: 404 }));
  await assert.rejects(missing.client.request("download", "ads.php?md5=1"), /Library Genesis returned 404\./);
  // Tried once per mirror, not again after waits.
  assert.equal(missing.asked.length, 2);
  const nginx = harness((url) =>
    url.startsWith("https://libgen.li/") ? new Response("<title>Welcome to nginx!</title>") : new Response(SEARCH),
  );
  assert.equal((await nginx.client.request("search", "index.php?req=a")).mirror, "https://libgen.la");
});

test("no mirror reached: the reach failure the series queue tries again; a private address is not a mirror being down", async () => {
  const h = harness(() => new TypeError("fetch failed"));
  await assert.rejects(h.client.request("search", "index.php?req=a"), (error: Error) => error.message === LIBGEN_UNREACHABLE);
  assert.equal(h.asked.length, 2);
  assert.deepEqual(h.lines, [
    "Library Genesis: libgen.li search page could not be reached (fetch failed)",
    "Library Genesis: libgen.la search page could not be reached (fetch failed)",
  ]);
  const refused = harness(() => new Error("Downloads from private network addresses are not allowed."));
  await assert.rejects(refused.client.request("download", "https://libgen.li/get.php?md5=1&key=x", { read: false }), /private network/);
  assert.equal(refused.asked.length, 1);
});

test("a keyed file link is tried on its own mirror only, and handed back unread", async () => {
  const h = harness((_url, n) => (n === 1 ? new Response(OVERLOADED, { status: 500 }) : new Response("PK\x03\x04")));
  const { response, body } = await h.client.request("download", "https://libgen.bz/get.php?md5=1&key=K", { read: false });
  assert.equal(body, null);
  assert.equal(await response.text(), "PK\x03\x04");
  assert.deepEqual(h.asked.map((entry) => entry.url), ["https://libgen.bz/get.php?md5=1&key=K", "https://libgen.bz/get.php?md5=1&key=K"]);
});
