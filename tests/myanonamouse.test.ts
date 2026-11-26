// MyAnonamouse (#911) on its recorded answers (tests/fixtures/myanonamouse/, recorded with the owner's session on
// 2026-11-25; the session, the download tokens, the passkey and the user id replaced): the search's parse, the client's
// one way to MAM (the allow-list, the cookie, the renewed session, a refused session said once and not retried), the
// `.torrent`'s facts, and the rows the Get sheets show. No request leaves the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.NODE_ENV = "test";

const {
  MAM_ENDPOINTS,
  MamRefusedError,
  createMamClient,
  mamAudiobookRelease,
  mamEbookKey,
  mamEbookResult,
  mamIdOf,
  mamIdOfEbookKey,
  mamLink,
  mamLinkId,
  parseMamSearch,
  renewedSession,
} = await import("../server/sources/myanonamouse.ts");
const { torrentFacts } = await import("../server/sources/torrent.ts");

const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/myanonamouse/${name}`, import.meta.url), "utf8");
const fixtureBytes = (name: string) => readFileSync(new URL(`./fixtures/myanonamouse/${name}`, import.meta.url));

test("the audiobook search's recorded answer: each row's title, authors, narrators, series, size, format, language, seeders and id", () => {
  const { results, tokens, found } = parseMamSearch(fixtureText("audio-search.json"));
  assert.equal(found, 14);
  assert.equal(results.length, 8);
  const first = results[0];
  assert.equal(first.id, 1097985);
  assert.equal(first.title, "Dungeon Crawler Carl");
  assert.deepEqual(first.authors, ["Matt Dinniman"]);
  assert.deepEqual(first.narrators, ["Jeff Hays"]);
  assert.deepEqual(first.series, [{ name: "Dungeon Crawler Carl", position: "1" }]);
  assert.equal(first.size, "738.5 MiB");
  assert.equal(first.format, "m4b");
  assert.equal(first.language, "English");
  assert.equal(first.mainCat, 13);
  assert.equal(typeof first.seeders, "number");
  assert.equal(first.bitrate, "128 kbps");
  // "13:31:33" in its media info.
  assert.equal(first.lengthMs, ((13 * 60 + 31) * 60 + 33) * 1000);
  assert.equal(first.url, "https://www.myanonamouse.net/t/1097985");
  // The German upload names its language; its row has no download token (MAM answered none for it).
  const german = results.find((release) => release.id === 1222742)!;
  assert.equal(german.language, "German");
  assert.equal(tokens.has(1222742), false);
  assert.equal(tokens.get(1097985), "DOWNLOAD-TOKEN?tid=1097985");
  // A row with twenty narrators keeps them all.
  assert.ok(results.find((release) => release.id === 1003009)!.narrators.length >= 20);
});

test("the ebook search's recorded answer: an EPUB row, a PDF row, and no row for a torrent of neither (CBZ, CBR)", () => {
  const { results } = parseMamSearch(fixtureText("ebook-search.json"));
  const rows = results.map((release) => mamEbookResult(release));
  const epub = rows.find((row) => row?.md5 === mamEbookKey(892986))!;
  assert.equal(epub.extension, "epub");
  assert.equal(epub.source, "mam");
  assert.equal(epub.language, "English");
  assert.deepEqual(epub.authors, ["Matt Dinniman"]);
  assert.equal(mamIdOfEbookKey(epub.md5), 892986);
  assert.equal(rows.find((row) => row?.md5 === mamEbookKey(1265674))?.extension, "pdf");
  assert.equal(mamEbookResult(results.find((release) => release.id === 1275929)!), null);
  // The Polish EPUB says its language.
  assert.equal(rows.find((row) => row?.md5 === mamEbookKey(1258777))?.language, "Polish");
});

test("an empty search answer is no result, and an unknown answer an error", () => {
  assert.deepEqual(parseMamSearch('{"error":"Nothing returned, out of 0"}').results, []);
  assert.throws(() => parseMamSearch("<html>not json</html>"), /did not answer with search results/);
  assert.throws(() => parseMamSearch('{"error":"Something else"}'), /Something else/);
});

test("a MAM row as the Get audiobook sheet's: its id, narrator, language and seeders; never cached on TorBox", () => {
  const release = mamAudiobookRelease(parseMamSearch(fixtureText("audio-search.json")).results[0]);
  assert.equal(release.id, "mam-1097985");
  assert.equal(mamIdOf(release.id), 1097985);
  assert.equal(release.source, "mam");
  assert.equal(release.narrator, "Jeff Hays");
  assert.equal(release.language, "English");
  assert.equal(release.format, "M4B");
  assert.equal(release.cached, false);
  assert.equal(release.infoHash, null);
  assert.equal(mamLinkId(mamLink(1097985)), "1097985");
  assert.equal(mamLinkId("magnet:?xt=urn:btih:abc"), null);
});

test("the recorded .torrent: its info hash, its name and its private flag; the passkey is never returned", () => {
  const data = fixtureBytes("892986.torrent");
  const facts = torrentFacts(data);
  assert.equal(facts.hash, "f12991833230a9155ba6955c2aaac69206beac35");
  assert.equal(facts.name, "Matt Dinniman - Dungeon Crawler Carl 1 - Dungeon Crawler Carl");
  assert.equal(facts.private, true);
  assert.equal(JSON.stringify(facts).includes("tracker.php"), false);
});

/** A fake MAM: the answers by endpoint, and every request it was asked. */
function fakeMam(answer: (url: URL, init: RequestInit) => Response) {
  const asked: { url: URL; cookie: string | null }[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    asked.push({ url, cookie: new Headers(init.headers).get("cookie") });
    return answer(url, init);
  };
  return { asked, fetch };
}

test("a download hash without its tid gets ?tid=<id> appended, as MAM's API list says", async () => {
  const bare = fixtureText("audio-search.json").replace(/(DOWNLOAD-TOKEN)\?tid=\d+/g, "$1");
  const mam = fakeMam((url) => {
    if (url.href.startsWith(MAM_ENDPOINTS.search.url)) return new Response(bare, { headers: { "content-type": "application/json" } });
    if (url.href.startsWith(MAM_ENDPOINTS.download.url))
      return new Response(fixtureBytes("892986.torrent"), { headers: { "content-type": "application/x-bittorrent" } });
    throw new Error(`not allowed: ${url}`);
  });
  const client = createMamClient({ fetch: mam.fetch, session: () => "a-session-value", saveSession: () => {} });
  await client.search("Dungeon Crawler Carl", "audio");
  await client.torrentFile(1097985);
  assert.equal(mam.asked[1].url.href, `${MAM_ENDPOINTS.download.url}DOWNLOAD-TOKEN?tid=1097985`);
});

test("the client calls only the allow-listed search and download, with the session as the mam_id cookie, and keeps the renewed session", async () => {
  const sessions: string[] = [];
  const mam = fakeMam((url) => {
    if (url.href.startsWith(MAM_ENDPOINTS.search.url))
      return new Response(fixtureText("audio-search.json"), {
        headers: { "content-type": "application/json", "set-cookie": "mam_id=renewed-session-value; path=/; domain=.myanonamouse.net" },
      });
    if (url.href.startsWith(MAM_ENDPOINTS.download.url))
      return new Response(fixtureBytes("892986.torrent"), { headers: { "content-type": "application/x-bittorrent" } });
    throw new Error(`not allowed: ${url}`);
  });
  let session = "first-session-value";
  const client = createMamClient({
    fetch: mam.fetch,
    session: () => session,
    saveSession: (next) => {
      sessions.push(next);
      session = next;
    },
  });
  const answer = await client.search("Dungeon Crawler Carl", "audio");
  assert.equal(answer.results.length, 8);
  const [search] = mam.asked;
  assert.equal(`${search.url.origin}${search.url.pathname}`, MAM_ENDPOINTS.search.url);
  assert.equal(search.url.searchParams.get("tor[text]"), "Dungeon Crawler Carl");
  assert.equal(search.url.searchParams.get("tor[main_cat][]"), "13");
  assert.equal(search.url.searchParams.get("dlLink"), "true");
  assert.equal(search.cookie, "mam_id=first-session-value");
  assert.deepEqual(sessions, ["renewed-session-value"]);
  // The search's token gets the .torrent: no second search.
  const file = await client.torrentFile(1097985);
  assert.equal(file[0], 0x64);
  assert.equal(mam.asked.length, 2);
  assert.equal(mam.asked[1].url.href, `${MAM_ENDPOINTS.download.url}DOWNLOAD-TOKEN?tid=1097985`);
  assert.equal(mam.asked[1].cookie, "mam_id=renewed-session-value");
  for (const { url } of mam.asked)
    assert.ok(Object.values(MAM_ENDPOINTS).some((endpoint) => url.href.startsWith(endpoint.url)), url.href);
});

test("a torrent no recent search listed is looked up by its id first (one search), then downloaded", async () => {
  const mam = fakeMam((url) => {
    if (url.href.startsWith(MAM_ENDPOINTS.search.url)) return new Response(fixtureText("details.json"), { headers: { "content-type": "application/json" } });
    return new Response(fixtureBytes("892986.torrent"), { headers: { "content-type": "application/x-bittorrent" } });
  });
  const client = createMamClient({ fetch: mam.fetch, session: () => "a-session-of-twenty-chars" });
  await client.torrentFile(892986);
  assert.equal(mam.asked.length, 2);
  assert.equal(mam.asked[0].url.searchParams.get("tor[id]"), "892986");
  assert.equal(mam.asked[0].url.searchParams.get("dlLink"), "true");
});

test("a refused session (the recorded 403) is said once, not retried, and noted for Settings; no session asks nothing", async () => {
  const refused: boolean[] = [];
  const mam = fakeMam(() => new Response(fixtureText("refused-403.html"), { status: 403, headers: { "content-type": "text/html" } }));
  const client = createMamClient({ fetch: mam.fetch, session: () => "a-stale-session", noteRefused: (value) => refused.push(value) });
  await assert.rejects(client.search("Dungeon Crawler Carl", "ebook"), (error: unknown) => error instanceof MamRefusedError);
  assert.equal(mam.asked.length, 1);
  assert.deepEqual(refused, [true]);
  const none = fakeMam(() => new Response("{}"));
  await assert.rejects(createMamClient({ fetch: none.fetch, session: () => undefined }).search("words", "audio"), /session in Settings/);
  assert.equal(none.asked.length, 0);
});

test("a renewed session is read from MAM's Set-Cookie", () => {
  // As it came: sent back as a browser would, never decoded.
  assert.equal(renewedSession(["mam_id=abc%2Bdef; expires=Thu, 10 Dec 2026 22:55:36 GMT; path=/"]), "abc%2Bdef");
  assert.equal(renewedSession(["other=1"]), null);
  assert.equal(renewedSession(["mam_id=deleted; path=/"]), null);
});

test("the allow-list is MAM's four documented functions, all confirmed; no other MAM address is written in the server or the scripts", () => {
  assert.deepEqual(Object.keys(MAM_ENDPOINTS).sort(), ["download", "dynamicSeedbox", "ipLookup", "search"]);
  for (const endpoint of Object.values(MAM_ENDPOINTS)) assert.equal(endpoint.confirmed, true);
  const script = readFileSync(new URL("../scripts/mam-dynamic-seedbox.sh", import.meta.url), "utf8");
  assert.ok(script.includes(`SEEDBOX_URL="${MAM_ENDPOINTS.dynamicSeedbox.url}"`));
  assert.ok(script.includes(`IP_URL="${MAM_ENDPOINTS.ipLookup.url}"`));
  // Every address of MAM's in the server: in the allow-list's module (its API, and the torrent page the owner opens).
  const root = new URL("../server/", import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  for (const path of files(root)) {
    if (path.endsWith(join("sources", "myanonamouse.ts"))) continue;
    assert.equal(/myanonamouse\.net/.test(readFileSync(path, "utf8")), false, path);
  }
});

test("the fixtures carry no session, download token, passkey or user id", () => {
  for (const name of ["audio-search.json", "ebook-search.json", "details.json"]) {
    const rows = (JSON.parse(fixtureText(name)) as { data: { id: number; dl?: string | null }[] }).data;
    for (const row of rows) assert.ok(row.dl === null || row.dl === undefined || row.dl === `DOWNLOAD-TOKEN?tid=${row.id}`, `${name} ${row.id}`);
  }
  const torrent = fixtureBytes("892986.torrent").toString("latin1");
  assert.ok(torrent.includes("tracker.php/PASSKEY/announce"));
  assert.ok(torrent.includes("MID=892986,UID=0"));
});
