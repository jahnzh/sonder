// The ebook sources (#901), with the answers recorded from each on 2026-11-25: Library Genesis's search and download
// pages (libgen.li, libgen.bz) and the 500 its download pages answered, Standard Ebooks' OPDS search, Project
// Gutenberg's maintenance page (it was down all day, so no search of it could be recorded), and Prowlarr's search of
// tests/fixtures/prowlarr-search.json. Then what the server does with them: the routes, an EPUB fetched straight from
// Standard Ebooks, a Prowlarr book release fetched through TorBox and imported into its book, and the series ebook
// search asking the sources in order and going back in the queue while Library Genesis limits requests.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-ebook-sources-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.TRANSMISSION_RPC_URL;

const { parseSearchPage, parseMirrorPage } = await import("../server/sources/libgen-parse.ts");
const { parseStandardEbooks, publicDomainDownload, publicDomainAge, publicDomainKey } = await import("../server/sources/public-domain.ts");
const { parseProwlarrEbooks, ebookReleaseFormat } = await import("../server/sources/prowlarr.ts");
const { LIBGEN_LIMITED } = await import("../server/sources/libgen-client.ts");
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { refreshAcquisition } = await import("../server/acquisitions.ts");
const { getWorkMediaState } = await import("../server/work-media-state.ts");
const { seriesEbookSources, fetchTopKIntoEbookSet, setEbookSetDeps, resetEbookSetDeps } = await import("../server/ebook-set.ts");
const { isSourceReachFailure, setSeriesAcquisitionDeps, resetSeriesAcquisitionDeps, tickSeriesAcquisition } = await import(
  "../server/series-acquisition.ts"
);
const { readerFixture } = await import("./reader-fixture.ts");

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const LIBGEN_SEARCH = fixture("libgen-search.html");
const LIBGEN_ADS = fixture("libgen-ads.html");
const LIBGEN_500 = fixture("libgen-ads-500.html");
const STANDARD_EBOOKS = fixture("standard-ebooks-search.xml");
const GUTENBERG_DOWN = fixture("gutenberg-maintenance-503.html");
const PROWLARR = JSON.parse(fixture("prowlarr-search.json"));

const app = await createApp({ background: { manual: ["acquisitions", "series-acquisition"] } });
const original = globalThis.fetch;
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler = (url) => {
  throw new Error(`Unexpected request: ${url}`);
};
const asked: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  asked.push(url.href);
  return handler(url, init);
};
beforeEach(() => {
  asked.length = 0;
  resetEbookSetDeps();
});
after(async () => {
  globalThis.fetch = original;
  resetSeriesAcquisitionDeps();
  await app.close();
  sqlite.close();
});

db.insert(s.settings).values({ key: "torbox", value: encrypt("ebook-sources-key") }).run();
db.insert(s.settings).values({ key: "prowlarr", value: encrypt("FIXTUREKEY") }).run();
db.insert(s.settings).values({ key: "prowlarrUrl", value: "http://127.0.0.1:9696" }).run();
const addWork = (id: string, title: string, author: string, year: number) =>
  db.insert(s.works).values({ id, title, author, description: "", genre: "", year }).onConflictDoNothing().run();

test("Library Genesis's recorded pages: the search table and a download page's keyed link and cover", () => {
  const files = parseSearchPage(LIBGEN_SEARCH);
  assert.equal(files.length, 25);
  assert.deepEqual(
    { ...files[0], isbns: undefined },
    {
      md5: "7a72d22ff9b6696e90ad924e42db2d12",
      title: "Dungeon Crawler Carl: Dungeon Crawler Carl Book 1",
      authors: ["Matt Dinniman"],
      publisher: "Dandy House",
      year: "2020",
      language: "English",
      size: "2 MB",
      extension: "epub",
      isbns: undefined,
    },
  );
  const page = parseMirrorPage(LIBGEN_ADS);
  assert.match(page.download!, /^get\.php\?md5=57cde5f547cb9eff0233238bc6d92a8e&key=[A-Z0-9]+$/);
  assert.equal(page.cover, "/fictioncovers/2674000/57cde5f547cb9eff0233238bc6d92a8e.jpg");
  // The 500 of the download pages is their database refusing more connections, not a page of the site.
  assert.match(LIBGEN_500, /max_user_connections/);
  assert.equal(parseMirrorPage(LIBGEN_500).download, null);
});

test("Standard Ebooks' recorded search: one EPUB per book, its file named from its page alone", () => {
  const files = parseStandardEbooks(STANDARD_EBOOKS);
  // Its whole answer for "tolstoy": nine books.
  assert.equal(files.length, 9);
  assert.deepEqual(files[0], {
    md5: publicDomainKey("https://standardebooks.org/ebooks/leo-tolstoy/the-power-of-darkness/louise-maude_aylmer-maude"),
    source: "standardebooks",
    title: "The Power of Darkness",
    authors: ["Leo Tolstoy"],
    extension: "epub",
    language: "English",
    size: files[0].size,
    year: files[0].year,
    coverUrl: "https://standardebooks.org/ebooks/leo-tolstoy/the-power-of-darkness/louise-maude_aylmer-maude/downloads/cover-thumbnail.jpg",
    url: "https://standardebooks.org/ebooks/leo-tolstoy/the-power-of-darkness/louise-maude_aylmer-maude",
  });
  assert.match(files[0].size!, /^\d+(\.\d+)? (KB|MB)$/);
  assert.match(files[0].year!, /^\d{4}$/);
  // Every recommended EPUB in the feed is the one derived from its book page.
  const feedLinks = [...STANDARD_EBOOKS.matchAll(/href="([^"]+\.epub\?source=feed)"[^>]*title="Recommended compatible epub"/g)].map((m) => m[1]);
  assert.equal(feedLinks.length, 9);
  assert.deepEqual(files.map((file) => publicDomainDownload("standardebooks", file.url)), feedLinks);
  // A page elsewhere is refused before anything is fetched.
  assert.throws(() => publicDomainDownload("standardebooks", "https://evil.example/ebooks/a/b"), /not a book page/);
  assert.throws(() => publicDomainDownload("gutenberg", "https://www.gutenberg.org/ebooks/1342/../../x"), /not a book page/);
  assert.equal(publicDomainDownload("gutenberg", "https://www.gutenberg.org/ebooks/1342"), "https://www.gutenberg.org/ebooks/1342.epub3.images");
});

test("Prowlarr's recorded search: its EPUB book releases, no audiobook, EPUBs first by seeders", () => {
  const { files, links } = parseProwlarrEbooks(PROWLARR);
  assert.ok(files.length >= 2);
  for (const file of files) {
    assert.equal(file.source, "prowlarr");
    assert.match(file.md5, /^[a-f0-9]{32}$/);
    assert.ok(links.has(`prowlarr-${file.md5}`));
    assert.doesNotMatch(file.title, /audiobook|m4b|mp3/i);
  }
  assert.deepEqual(
    { title: files[0].title, extension: files[0].extension, indexer: files[0].indexer, seeders: files[0].seeders, size: files[0].size, year: files[0].year },
    { title: "Project Hail Mary by Andy Weir EPUB", extension: "epub", indexer: "The Pirate Bay", seeders: 356, size: "9.37 MB", year: "2022" },
  );
  assert.equal(files[0].url, "https://thepiratebay.org/description.php?id=64625353");
  assert.equal(files[0].infoHash, "460251772325303420dabf9f83e0312a47d63024");
  assert.deepEqual(files.map((file) => file.seeders), [356, 146, 36, 24, 23]);
  // The audio search's own parse still takes none of them as an audiobook.
  assert.equal(ebookReleaseFormat("Book PDF + EPUB"), "epub");
  assert.equal(ebookReleaseFormat("Book [MOBI]"), null);
});

test("an old book adds the public-domain sources to the series search; Prowlarr only when connected", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  assert.deepEqual(seriesEbookSources({ year: 2020 }, true, now), ["libgen", "prowlarr"]);
  assert.deepEqual(seriesEbookSources({ year: 1813 }, false, now), ["libgen", "standardebooks", "gutenberg"]);
  assert.deepEqual(seriesEbookSources({ year: null }, false, now), ["libgen"]);
  assert.equal(publicDomainAge(1930, now), true);
  assert.equal(publicDomainAge(1931, now), false);
});

test("the search route asks each source on its own; an older client's request without a source is Library Genesis's", async () => {
  handler = (url) => {
    if (url.hostname === "libgen.li") return new Response(LIBGEN_SEARCH);
    if (url.hostname === "standardebooks.org") return new Response(STANDARD_EBOOKS, { headers: { "Content-Type": "application/atom+xml" } });
    if (url.hostname === "www.gutenberg.org") return new Response(GUTENBERG_DOWN, { status: 503, headers: { "Content-Type": "text/html" } });
    if (url.host === "127.0.0.1:9696") return Response.json(PROWLARR);
    if (url.hostname === "api.torbox.app") return Response.json({ success: true, data: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  const libgen = await app.inject("/api/discover/ebooks?q=dungeon+crawler+carl");
  assert.equal(libgen.statusCode, 200, libgen.body);
  assert.equal(libgen.json().files[0].source, "libgen");
  assert.equal(libgen.json().files[0].url, "https://libgen.li/ads.php?md5=7a72d22ff9b6696e90ad924e42db2d12");
  const standard = await app.inject("/api/discover/ebooks?source=standardebooks&q=tolstoy");
  assert.equal(standard.statusCode, 200, standard.body);
  assert.equal(standard.json().files.length, 9);
  assert.equal(new URL(asked.find((href) => href.includes("standardebooks"))!).searchParams.get("query"), "tolstoy");
  const prowlarr = await app.inject("/api/discover/ebooks?source=prowlarr&q=project+hail+mary");
  assert.equal(prowlarr.statusCode, 200, prowlarr.body);
  assert.equal(prowlarr.json().files[0].source, "prowlarr");
  // Prowlarr's book categories are asked, not its audio one.
  assert.deepEqual(new URL(asked.find((href) => href.includes("9696"))!).searchParams.getAll("categories"), ["7000", "7020"]);
  // Project Gutenberg down for maintenance: a reach failure of its own, which the series queue tries again.
  const gutenberg = await app.inject("/api/discover/ebooks?source=gutenberg&q=pride");
  assert.equal(gutenberg.statusCode, 400);
  assert.equal(gutenberg.json().error, "Project Gutenberg is unavailable (503).");
  assert.ok(isSourceReachFailure(gutenberg.json().error));
});

test("Library Genesis limiting every try: the route answers 503 with its code, the series queue's reach failure", async () => {
  handler = (url) => (url.hostname.startsWith("libgen.") ? new Response(LIBGEN_500, { status: 500 }) : Promise.reject(new Error(`Unexpected ${url}`)));
  const search = await app.inject("/api/discover/ebooks?source=libgen&q=dungeon+crawler+carl");
  assert.equal(search.statusCode, 503, search.body);
  assert.equal(search.json().error, LIBGEN_LIMITED);
  assert.equal(search.json().code, "source_limited");
  assert.equal(search.json().retryable, true);
  assert.ok(search.headers["retry-after"] !== undefined);
  // The Settings mirror first, then the next of the family; each tried again (the suite's timing has no waits).
  assert.deepEqual([...new Set(asked.map((href) => new URL(href).host))], ["libgen.li", "libgen.la"]);
  assert.equal(asked.length, 6);
  assert.ok(isSourceReachFailure(LIBGEN_LIMITED));
});

test("Get this edition of Standard Ebooks: the EPUB derived from its page is saved into the book, no checksum asked", async () => {
  addWork("work-se", "The Power of Darkness", "Leo Tolstoy", 1886);
  const epub = await readerFixture({ title: "The Power of Darkness" });
  const [file] = parseStandardEbooks(STANDARD_EBOOKS);
  handler = (url) => {
    if (url.href === publicDomainDownload("standardebooks", file.url))
      return new Response(new Uint8Array(epub), { headers: { "Content-Length": String(epub.length) } });
    throw new Error(`Unexpected request: ${url}`);
  };
  // The client's url is the page; anything else it sends is not fetched.
  const saved = await app.inject({ method: "POST", url: "/api/ebooks", payload: { ...file, workId: "work-se" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().id, `standardebooks-${file.md5}`);
  const row = db.select().from(s.ebookEditions).where(eq(s.ebookEditions.id, saved.json().id)).get()!;
  assert.equal(row.workId, "work-se");
  assert.equal(row.format, "epub");
  assert.ok(existsSync(row.source));
  assert.deepEqual(asked, [publicDomainDownload("standardebooks", file.url)]);
});

test("Get this edition of a Prowlarr release: an ebook download through TorBox, its EPUB imported into the book", async () => {
  addWork("work-phm", "Project Hail Mary", "Andy Weir", 2021);
  const epub = await readerFixture({ title: "Project Hail Mary" });
  // The release's own hash: its magnet is Prowlarr's answer.
  const hash = "460251772325303420dabf9f83e0312a47d63024";
  handler = (url) => {
    if (url.host === "127.0.0.1:9696" && url.pathname === "/api/v1/search") return Response.json(PROWLARR);
    // The release's link answers with its magnet, as Prowlarr does for a magnet-only indexer.
    if (url.host === "127.0.0.1:9696") return new Response(null, { status: 302, headers: { Location: `magnet:?xt=urn:btih:${hash}&dn=PHM` } });
    if (url.hostname === "api.torbox.app") {
      const path = url.pathname;
      const data = path.endsWith("checkcached")
        ? (url.searchParams.get("hash") ?? "").split(",").filter((asked) => asked === hash).map((asked) => ({ hash: asked }))
        : path.endsWith("createtorrent")
          ? { torrent_id: 77 }
          : path.endsWith("mylist")
            ? { download_present: true, files: [{ id: 1, name: "PHM/cover.jpg" }, { id: 2, name: "PHM/Project Hail Mary.mobi" }, { id: 3, name: "PHM/Project Hail Mary.epub", short_name: "Project Hail Mary.epub" }] }
            : path.endsWith("requestdl")
              ? url.searchParams.get("file_id") === "3" ? "https://store.torbox.fixture/phm.epub" : "https://store.torbox.fixture/wrong"
              : null;
      return Response.json({ success: true, data });
    }
    if (url.href === "https://store.torbox.fixture/phm.epub") return new Response(new Uint8Array(epub), { headers: { "Content-Length": String(epub.length) } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const search = await app.inject("/api/discover/ebooks?source=prowlarr&q=project+hail+mary");
  const release = search.json().files[0];
  assert.equal(release.cached, true);
  const got = await app.inject({ method: "POST", url: "/api/ebooks", payload: { ...release, workId: "work-phm" } });
  assert.equal(got.statusCode, 200, got.body);
  const { acquisition } = got.json();
  assert.ok(acquisition.id);
  const job = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, acquisition.id)).get()!;
  assert.equal(job.kind, "ebook");
  assert.equal(job.workId, "work-phm");
  // Not the book's audio on its way.
  assert.notEqual(getWorkMediaState(1, "work-phm")?.state, "queued");
  await refreshAcquisition(job.id);
  const done = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, job.id)).get()!;
  assert.equal(done.status, "ready", done.error ?? "");
  assert.equal(done.bookId, null);
  const editions = db.select().from(s.ebookEditions).where(eq(s.ebookEditions.workId, "work-phm")).all();
  assert.equal(editions.length, 1);
  assert.equal(editions[0].id, `upload-${createHash("md5").update(epub).digest("hex")}`);
  assert.equal(editions[0].format, "epub");
  // In the library of the one who got it (by the book's placeholder, as an upload), and no audio track was made.
  const audio = db.select().from(s.editions).where(eq(s.editions.workId, "work-phm")).all();
  assert.deepEqual(audio.map((edition) => edition.id), ["placeholder-work-phm"]);
  const recordings = db.select().from(s.recordings).where(eq(s.recordings.editionId, "placeholder-work-phm")).all();
  assert.ok(recordings.every((recording) => !db.select().from(s.tracks).where(eq(s.tracks.recordingId, recording.id)).get()));
  assert.ok(db.select().from(s.userLibrary).where(eq(s.userLibrary.userId, 1)).all().some((row) => audio.some((edition) => edition.id === row.bookId)));
  // Activity names it an ebook.
  const activity = (await app.inject("/api/activity")).json();
  const item = activity.items.find((entry: { id: string }) => entry.id === `acquisition:${job.id}`);
  assert.deepEqual(item.facts, { kind: "acquisition", status: "ready", backend: "torbox", file: "ebook" });
  // A Prowlarr release without a book is refused.
  const orphan = await app.inject({ method: "POST", url: "/api/ebooks", payload: { ...release } });
  assert.equal(orphan.statusCode, 400);
  assert.equal(orphan.json().error, "Choose the book this ebook is for.");
});

test("the series ebook search asks the sources in order: Library Genesis limited, Prowlarr's release started", async () => {
  addWork("work-series-1", "Project Hail Mary", "Andy Weir", 2021);
  const order: string[] = [];
  const started: string[] = [];
  const { files: releases } = parseProwlarrEbooks(PROWLARR);
  setEbookSetDeps({
    search: async (source) => {
      order.push(source);
      if (source === "libgen") throw Object.assign(new Error(LIBGEN_LIMITED), { retryAt: Date.now() + 60_000 });
      return { files: releases.map((release) => ({ ...release })), website: "" };
    },
    startTorrent: async (file) => {
      started.push(file.title);
      return { id: "acquisition-1" };
    },
  });
  const result = await fetchTopKIntoEbookSet("work-series-1", "libgen", { sources: ["libgen", "prowlarr", "standardebooks"] });
  assert.deepEqual(order, ["libgen", "prowlarr"]);
  assert.deepEqual(started, ["Project Hail Mary by Andy Weir EPUB"]);
  assert.equal(result.started, "acquisition-1");
  assert.deepEqual(result.failures, [LIBGEN_LIMITED]);
});

test("a series ebook job whose sources limited requests goes back in the queue for later, not done with an error", async () => {
  addWork("work-series-2", "Dungeon Crawler Carl", "Matt Dinniman", 2020);
  sqlite.prepare("INSERT OR IGNORE INTO series_catalogue(id,name,author,book_count) VALUES('series-dcc','Dungeon Crawler Carl','Matt Dinniman',7)").run();
  sqlite
    .prepare("INSERT INTO series_acquisition_jobs(id,user_id,series_id,book_id,work_id,kind,status,error,updated_at) VALUES('job-dcc',1,'series-dcc','bk-1','work-series-2','ebook','pending',NULL,?)")
    .run(Date.now());
  const until = Date.now() + 10 * 60_000;
  setSeriesAcquisitionDeps({
    canAcquireMedia: () => true,
    // Library Genesis limited; an edition that did not match the narration does not end the search.
    fetchEbooks: async () => ({ downloaded: [{ id: "libgen-x", status: "rejected" as const }], skipped: null, failures: [LIBGEN_LIMITED] }),
  });
  const { libgen } = await import("../server/ebooks.ts");
  const resting = libgen.restingUntil;
  (libgen as { restingUntil: typeof resting }).restingUntil = () => until;
  try {
    await tickSeriesAcquisition();
  } finally {
    (libgen as { restingUntil: typeof resting }).restingUntil = resting;
  }
  const job = db.select().from(s.seriesAcquisitionJobs).where(eq(s.seriesAcquisitionJobs.id, "job-dcc")).get()!;
  assert.equal(job.status, "pending");
  assert.equal(job.error, LIBGEN_LIMITED);
  assert.equal(job.autoRetries, 1);
  // Not before Library Genesis rests out, nor before the queue's own step.
  assert.ok(job.retryAt! >= until, `${job.retryAt} < ${until}`);
  // Activity says so with the time.
  const activity = (await app.inject("/api/activity")).json();
  const item = activity.items.find((entry: { id: string }) => entry.id.endsWith("job-dcc"));
  assert.equal(item.facts.retryAt, job.retryAt);
  assert.equal(item.error, LIBGEN_LIMITED);
});

const { chooseEbookFile, idleLimit } = await import("../server/ebook-torrents.ts");

test("a torrent's ebook: its one EPUB, else its PDF; of a collection only the file named after the book", () => {
  const files = (...names: string[]) => names.map((name) => ({ name }));
  assert.equal(chooseEbookFile(files("PHM/cover.jpg", "PHM/Project Hail Mary.mobi", "PHM/Project Hail Mary.epub"), "Project Hail Mary")?.name, "PHM/Project Hail Mary.epub");
  assert.equal(chooseEbookFile(files("PHM/Project Hail Mary.pdf", "PHM/readme.txt"), "Project Hail Mary")?.name, "PHM/Project Hail Mary.pdf");
  assert.equal(chooseEbookFile(files("a.mobi", "b.azw3"), "Anything"), null);
  const series = files(
    "Dinniman - Dungeon Crawler Carl/01 - Dungeon Crawler Carl.epub",
    "Dinniman - Dungeon Crawler Carl/02 - Carl's Doomsday Scenario.epub",
    "Dinniman - Dungeon Crawler Carl/05 - The Butcher's Masquerade.epub",
  );
  assert.equal(chooseEbookFile(series, "The Butcher's Masquerade")?.name, series[2].name);
  assert.equal(chooseEbookFile(series, "Carl's Doomsday Scenario")?.name, series[1].name);
  // No file of the collection is this book: nothing, rather than another book.
  assert.equal(chooseEbookFile(series, "The Gate of the Feral Gods"), null);
});

test("a transfer that stops sending fails after its idle limit", async () => {
  const limited = idleLimit(30);
  limited.write("PK");
  await assert.rejects(
    new Promise((resolve, reject) => {
      limited.on("error", reject);
      limited.on("end", resolve);
      limited.resume();
    }),
    /stalled/,
  );
});

test("Get this edition of a Prowlarr release already fetched for another book fetches it again for this one", async () => {
  addWork("work-phm-2", "Project Hail Mary", "Andy Weir", 2021);
  const before = db.select().from(s.acquisitions).all().find((row) => row.kind === "ebook" && row.status === "ready");
  assert.ok(before, "the earlier test's download is ready");
  const epub = await readerFixture({ title: "Project Hail Mary again" });
  const hash = before.hash;
  handler = (url) => {
    if (url.host === "127.0.0.1:9696" && url.pathname === "/api/v1/search") return Response.json(PROWLARR);
    if (url.hostname === "api.torbox.app") {
      const path = url.pathname;
      const data = path.endsWith("checkcached")
        ? (url.searchParams.get("hash") ?? "").split(",").filter((asked) => asked === hash).map((asked) => ({ hash: asked }))
        : path.endsWith("createtorrent")
          ? { torrent_id: 78 }
          : path.endsWith("mylist")
            ? { download_present: true, files: [{ id: 3, name: "PHM/Project Hail Mary.epub" }] }
            : "https://store.torbox.fixture/phm2.epub";
      return Response.json({ success: true, data });
    }
    if (url.href === "https://store.torbox.fixture/phm2.epub") return new Response(new Uint8Array(epub), { headers: { "Content-Length": String(epub.length) } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const release = (await app.inject("/api/discover/ebooks?source=prowlarr&q=project+hail+mary")).json().files[0];
  const got = await app.inject({ method: "POST", url: "/api/ebooks", payload: { ...release, workId: "work-phm-2" } });
  assert.equal(got.statusCode, 200, got.body);
  assert.equal(got.json().acquisition.id, before.id);
  await refreshAcquisition(before.id);
  const row = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, before.id)).get()!;
  assert.equal(row.status, "ready", row.error ?? "");
  assert.equal(row.workId, "work-phm-2");
  assert.equal(db.select().from(s.ebookEditions).where(eq(s.ebookEditions.workId, "work-phm-2")).all().length, 1);
});

test("the series search tries a book's Prowlarr download once: a finished one sends it to the next source", async () => {
  const workId = "work-phm-2";
  const order: string[] = [];
  let startedAgain = 0;
  setEbookSetDeps({
    search: async (source) => {
      order.push(source);
      return { files: source === "prowlarr" ? parseProwlarrEbooks(PROWLARR).files : [], website: "" };
    },
    startTorrent: async () => {
      startedAgain++;
      return { id: "x" };
    },
  });
  const result = await fetchTopKIntoEbookSet(workId, "libgen", { sources: ["libgen", "prowlarr", "standardebooks"] });
  assert.equal(startedAgain, 0);
  assert.equal(result.started ?? null, null);
  assert.deepEqual(order, ["libgen", "prowlarr", "standardebooks"]);
});
