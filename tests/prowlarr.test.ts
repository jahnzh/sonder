import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudiobookRelease } from "../src/types.ts";
const temp = mkdtempSync(join(tmpdir(), "sonder-prowlarr-test-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.TRANSMISSION_RPC_URL;
const { parseProwlarrResults, prowlarrRequestUrl, resolveProwlarrLink, releaseDisplayTitle } =
  await import("../server/sources/prowlarr.ts");
const { torrentToMagnet } = await import("../server/sources/torrent.ts");
const { mergeReleases, sortReleases, matchesLanguage, sizeBytes } = await import(
  "../src/releases.ts"
);
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/prowlarr-search.json", import.meta.url), "utf8"),
);
const config = { url: "http://127.0.0.1:9696", key: "FIXTUREKEY" };

function bencode(value: unknown): Buffer {
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${data.length}:`), data]);
  }
  if (Array.isArray(value))
    return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  return Buffer.concat([
    Buffer.from("d"),
    ...entries.flatMap(([key, item]) => [bencode(key), bencode(item)]),
    Buffer.from("e"),
  ]);
}
const info = {
  length: 1234,
  name: "Fixture Story [M4B]",
  "piece length": 16384,
  pieces: Buffer.alloc(20, 7),
};
const torrent = bencode({
  announce: "udp://tracker.example.test:1337/announce",
  "announce-list": [["udp://tracker.example.test:1337/announce"], ["https://t2.example.test/announce"]],
  info,
});
const torrentHash = createHash("sha1").update(bencode(info)).digest("hex");

const release = (overrides: Partial<AudiobookRelease>): AudiobookRelease => ({
  id: "x",
  title: "Project Hail Mary",
  author: "Andy Weir",
  url: "",
  language: null,
  narrator: null,
  format: null,
  bitrate: null,
  size: null,
  posted: null,
  uploader: null,
  description: "",
  ...overrides,
});

test("Prowlarr results keep audiobooks, drop ebooks and never expose download links", () => {
  const { releases, links } = parseProwlarrResults(fixture);
  assert.equal(fixture.length, 11);
  assert.deepEqual(
    releases.map((r) => r.indexer),
    ["1337x", "1337x", "RuTracker.org", "The Pirate Bay"],
  );
  const tpb = releases.find((r) => r.indexer === "The Pirate Bay")!;
  assert.equal(tpb.infoHash, "0f54898dc1b8e49d96e32827377f651ea6c935af");
  assert.equal(tpb.seeders, 338);
  assert.equal(tpb.sizeBytes, 933905216);
  assert.equal(tpb.size, "891 MB");
  assert.equal(tpb.source, "prowlarr");
  assert.match(tpb.id, /^prowlarr-[a-f0-9]{32}$/);
  const mrJones = releases[0];
  assert.equal(mrJones.format, "M4B");
  assert.equal(mrJones.posted, "2024-12-13");
  assert.equal(mrJones.url, fixture[0].infoUrl);
  const rutracker = releases.find((r) => r.indexer === "RuTracker.org")!;
  assert.equal(rutracker.format, "MP3");
  assert.equal(rutracker.bitrate, "128 Kbps");
  assert.ok(!JSON.stringify(releases).includes("apikey"));
  assert.ok(!JSON.stringify(releases).includes("FIXTUREKEY"));
  assert.match(links.get(mrJones.id)!.downloadUrl!, /apikey=FIXTUREKEY/);
  // Book-category results are kept only when the title marks them as audio.
  const extra = parseProwlarrResults([
    { title: "Some Book (Unabridged) [M4B]", categories: [{ id: 7000 }], infoHash: "a".repeat(40), protocol: "torrent" },
    { title: "Some Book EPUB", categories: [{ id: 7020 }], infoHash: "b".repeat(40), protocol: "torrent" },
    { title: "Usenet audiobook", categories: [{ id: 3030 }], downloadUrl: "http://x/1/download", protocol: "usenet" },
    { title: "No link audiobook", categories: [{ id: 3030 }], protocol: "torrent" },
    null,
  ]);
  assert.deepEqual(extra.releases.map((r) => r.title), ["Some Book (Unabridged) [M4B]"]);
  assert.deepEqual(parseProwlarrResults({ message: "nope" }).releases, []);
});

test("release names become readable library titles", () => {
  assert.equal(
    releaseDisplayTitle("Project Hail Mary - Andy Weir - 2021 (Sci Fi) [Audiobook] (miok)"),
    "Project Hail Mary - Andy Weir - 2021",
  );
  assert.equal(releaseDisplayTitle("[M4B]"), "[M4B]");
});

test("torrent files resolve to a magnet with the info-dictionary hash and trackers", () => {
  const { hash, magnet } = torrentToMagnet(torrent);
  assert.equal(hash, torrentHash);
  const url = new URL(magnet);
  assert.equal(url.searchParams.get("xt"), `urn:btih:${torrentHash}`);
  assert.equal(url.searchParams.get("dn"), "Fixture Story [M4B]");
  assert.deepEqual(url.searchParams.getAll("tr"), [
    "udp://tracker.example.test:1337/announce",
    "https://t2.example.test/announce",
  ]);
  assert.throws(() => torrentToMagnet(Buffer.from("<html>not a torrent</html>")));
  assert.throws(() => torrentToMagnet(torrent.subarray(0, 40)));
  assert.throws(() => torrentToMagnet(bencode({ announce: "x" })));
});

test("download links are only replayed against the configured Prowlarr", () => {
  assert.equal(
    prowlarrRequestUrl(config, "http://localhost:9696/2/download?apikey=k&link=a"),
    "http://127.0.0.1:9696/2/download?apikey=k&link=a",
  );
  assert.equal(
    prowlarrRequestUrl(
      { ...config, url: "https://home.example.test/prowlarr" },
      "http://127.0.0.1:9696/prowlarr/4/download?link=a",
    ),
    "https://home.example.test/prowlarr/4/download?link=a",
  );
  assert.throws(() => prowlarrRequestUrl(config, "http://127.0.0.1:9696/api/v1/indexer"));
  assert.throws(() => prowlarrRequestUrl(config, "https://evil.example.test/x?y=1"));
  assert.throws(() =>
    prowlarrRequestUrl({ ...config, url: "http://h/prowlarr" }, "http://h/other/2/download"),
  );
});

test("Prowlarr links resolve magnets, torrent files and bare hashes without leaving Prowlarr", async () => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  let mode: "redirect" | "torrent" | "fail" | "external" = "redirect";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    assert.equal(init?.redirect, "manual");
    if (mode === "redirect")
      return new Response(null, {
        status: 301,
        headers: { Location: "magnet:?xt=urn:btih:" + "d".repeat(40) + "&tr=udp://t" },
      });
    if (mode === "external")
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/x" } });
    if (mode === "torrent")
      return new Response(new Uint8Array(torrent), {
        headers: { "Content-Type": "application/x-bittorrent" },
      });
    return new Response("nope", { status: 500 });
  };
  try {
    const link = {
      title: "Fixture",
      magnetUrl: "http://127.0.0.1:9696/10/download?apikey=FIXTUREKEY&link=a",
      downloadUrl: null,
      infoHash: "e".repeat(40),
    };
    assert.match(await resolveProwlarrLink(config, link), /urn:btih:d{40}&tr=/);
    mode = "torrent";
    assert.match(
      await resolveProwlarrLink(config, { ...link, magnetUrl: null, downloadUrl: link.magnetUrl, infoHash: null }),
      new RegExp(`urn:btih:${torrentHash}`),
    );
    mode = "fail";
    assert.equal(
      await resolveProwlarrLink(config, link),
      `magnet:?xt=urn:btih:${"e".repeat(40)}&dn=Fixture`,
    );
    await assert.rejects(
      resolveProwlarrLink(config, { ...link, infoHash: null }),
      /could not fetch this torrent/,
    );
    mode = "external";
    await assert.rejects(
      resolveProwlarrLink(config, { ...link, infoHash: null }),
      /redirected this release elsewhere/,
    );
    assert.equal(
      await resolveProwlarrLink(config, { ...link, magnetUrl: "magnet:?xt=urn:btih:" + "f".repeat(40) }),
      "magnet:?xt=urn:btih:" + "f".repeat(40),
    );
    assert.ok(requested.every((url) => url.startsWith("http://127.0.0.1:9696/10/download?")));
  } finally {
    globalThis.fetch = original;
  }
});

test("merged releases dedupe by info hash, then by title and size", () => {
  const abb = release({ id: "phm-abb", source: undefined, size: "890.6 MBs", language: "English" });
  const tpb = release({
    id: "prowlarr-1",
    source: "prowlarr",
    indexer: "The Pirate Bay",
    title: "Andy Weir - Project Hail Mary",
    author: "",
    sizeBytes: 933905216,
    seeders: 338,
    infoHash: "0f54898dc1b8e49d96e32827377f651ea6c935af",
  });
  const mirror = release({
    ...tpb,
    id: "prowlarr-2",
    indexer: "1337x",
    title: "Different name, same torrent",
    seeders: 400,
    infoHash: tpb.infoHash!.toUpperCase(),
    cached: true,
  });
  const otherSize = release({ ...tpb, id: "prowlarr-3", infoHash: null, sizeBytes: 469176928, seeders: 42 });
  const merged = mergeReleases([abb], [tpb, mirror, otherSize]);
  assert.equal(merged.length, 2);
  // AudioBookBay stays primary (it has language and details); indexers and health merge in.
  assert.equal(merged[0].id, "phm-abb");
  assert.deepEqual(merged[0].indexers, ["AudioBookBay", "1337x", "The Pirate Bay"]);
  assert.equal(merged[0].seeders, 400);
  assert.equal(merged[0].cached, true);
  assert.equal(merged[0].infoHash, tpb.infoHash);
  assert.equal(merged[1].id, "prowlarr-3");
  // Two indexers with the same hash keep the better-seeded record.
  const pair = mergeReleases([tpb], [mirror]);
  assert.equal(pair.length, 1);
  assert.equal(pair[0].id, "prowlarr-2");
  // Two AudioBookBay posts or two uploads on one indexer stay separate even with equal title and size.
  assert.equal(mergeReleases([abb], [{ ...abb, id: "other-post", language: "French" }]).length, 2);
  assert.equal(mergeReleases([abb], [{ ...abb, id: "other-post" }]).length, 2);
  assert.equal(mergeReleases([otherSize], [{ ...otherSize, id: "prowlarr-4" }]).length, 2);
  // Same title, unknown size: kept separate rather than guessed.
  assert.equal(mergeReleases([abb], [release({ id: "y", source: "prowlarr" })]).length, 2);
  // A repeated id (a later page) updates in place.
  assert.equal(mergeReleases([abb], [{ ...abb, narrator: "Ray Porter" }])[0].narrator, "Ray Porter");
  assert.equal(sizeBytes({ size: "1.5 GB" }), 1.5 * 1024 ** 3);
  assert.equal(sizeBytes({ size: null }), null);
});

test("release sorting favours relevance, TorBox cache, then seeders", () => {
  const sorted = sortReleases(
    [
      release({ id: "unrelated", title: "Something else", seeders: 900, source: "prowlarr" }),
      release({ id: "abb" }),
      release({ id: "dead", title: "Project Hail Mary M4B", seeders: 0, source: "prowlarr" }),
      release({ id: "seeded", title: "Andy Weir - Project Hail Mary", seeders: 50, source: "prowlarr" }),
      release({ id: "cached", title: "Project Hail Mary (2021)", seeders: 3, cached: true, source: "prowlarr" }),
    ],
    "Project Hail Mary",
  );
  assert.deepEqual(sorted.map((r) => r.id), ["abb", "dead", "cached", "seeded", "unrelated"]);
  assert.equal(matchesLanguage(release({ source: "prowlarr" }), "English"), true);
  assert.equal(matchesLanguage(release({ language: "French" }), "English"), false);
  assert.equal(matchesLanguage(release({}), "English"), false);
});

test("Prowlarr settings are encrypted, searches stay isolated and chosen releases use TorBox-first routing", async () => {
  const original = globalThis.fetch;
  const hash = "0f54898dc1b8e49d96e32827377f651ea6c935af";
  let searchUrl = "",
    cachedHashes = "",
    created = false,
    searchStatus = 200;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://prowlarr.test:9696/")) {
      assert.equal(new Headers(init?.headers).get("X-Api-Key"), "secret-prowlarr-key");
      if (url.includes("/api/v1/system/status")) return Response.json({ version: "2.3.0" });
      if (url.includes("/api/v1/indexer"))
        return Response.json([
          { enable: true, protocol: "torrent" },
          { enable: false, protocol: "torrent" },
          { enable: true, protocol: "usenet" },
        ]);
      if (url.includes("/api/v1/search")) {
        searchUrl = url;
        return searchStatus === 200
          ? Response.json(fixture)
          : new Response("", { status: searchStatus });
      }
      if (url.includes("/10/download"))
        return new Response(null, {
          status: 301,
          headers: { Location: `magnet:?xt=urn:btih:${hash}&dn=PHM&tr=udp://t` },
        });
    }
    let data: unknown;
    if (url.includes("checkcached")) {
      cachedHashes = new URL(url).searchParams.get("hash") || "";
      data = [{ hash }];
    } else if (url.includes("createtorrent")) {
      created = true;
      assert.equal((init!.body as FormData).get("add_only_if_cached"), "true");
      assert.match(String((init!.body as FormData).get("magnet")), /tr=udp/);
      data = { torrent_id: 91 };
    } else if (url.includes("mylist"))
      data = { download_present: true, files: [{ id: 1, name: "PHM/Chapter 1.m4b" }] };
    else return original(input, init);
    return Response.json({ success: true, data });
  };
  try {
    assert.equal((await app.inject("/api/settings")).json().prowlarrConfigured, false);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/prowlarr/test" })).statusCode,
      400,
    );
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { prowlarrUrl: "http://prowlarr.test:9696/", prowlarr: "secret-prowlarr-key" },
    });
    assert.equal(saved.statusCode, 200);
    const stored = db.select().from(s.settings).where(eq(s.settings.key, "prowlarr")).get()!;
    assert.ok(!stored.value.includes("secret-prowlarr-key"));
    const settings = (await app.inject("/api/settings")).json();
    assert.equal(settings.prowlarrConfigured, true);
    assert.equal(settings.prowlarrUrl, "http://prowlarr.test:9696");
    assert.ok(!JSON.stringify(settings).includes("secret-prowlarr-key"));
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/prowlarr/test" })).json(), {
      ok: true,
      version: "2.3.0",
      indexers: 1,
    });

    const search = await app.inject("/api/discover/prowlarr/releases?q=project%20hail%20mary");
    assert.equal(search.statusCode, 200);
    assert.deepEqual(new URL(searchUrl).searchParams.getAll("categories"), ["3030", "7000"]);
    const body = search.json() as { results: AudiobookRelease[] };
    assert.equal(body.results.length, 4);
    assert.ok(!search.body.includes("FIXTUREKEY"));
    // No TorBox account yet, so nothing is checked or marked cached.
    assert.equal(cachedHashes, "");
    assert.equal(body.results.filter((r) => r.cached).length, 0);
    const tpb = body.results.find((r) => r.infoHash === hash)!;

    const missing = await app.inject({
      method: "POST",
      url: "/api/discover/prowlarr/add",
      payload: { id: "prowlarr-" + "0".repeat(32) },
    });
    assert.match(missing.json().error, /expired/);
    // TorBox is not connected yet: the release must fall through to the local client, like AudioBookBay.
    const local = await app.inject({
      method: "POST",
      url: "/api/discover/prowlarr/add",
      payload: { id: tpb.id },
    });
    assert.match(local.json().error, /local torrent client is not configured/);
    assert.equal(created, false);
    db.insert(s.settings).values({ key: "torbox", value: encrypt("fake-key") }).run();
    db.update(s.acquisitions).set({ status: "error" }).run();
    const cachedSearch = (
      await app.inject("/api/discover/prowlarr/releases?q=project%20hail%20mary")
    ).json() as { results: AudiobookRelease[] };
    assert.equal(cachedHashes, hash);
    assert.deepEqual(
      cachedSearch.results.filter((r) => r.cached).map((r) => r.id),
      [tpb.id],
    );
    const job = (
      await app.inject({ method: "POST", url: "/api/discover/prowlarr/add", payload: { id: tpb.id } })
    ).json();
    assert.equal(created, true);
    assert.equal(job.backend, "torbox");
    assert.equal(job.status, "ready");
    assert.equal(job.hash, hash);
    assert.equal(job.title, "Andy Weir - Project Hail Mary");

    searchStatus = 401;
    const rejected = await app.inject("/api/discover/prowlarr/releases?q=project");
    assert.match(rejected.json().error, /rejected the API key/);
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { prowlarr: "", prowlarrUrl: "" } });
    assert.equal((await app.inject("/api/settings")).json().prowlarrConfigured, false);
    assert.match(
      (await app.inject("/api/discover/prowlarr/releases?q=project")).json().error,
      /Connect Prowlarr/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
