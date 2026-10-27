import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-releases-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp, listBooks } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { magnetHash } = await import("../server/acquisitions.ts");
const app = await createApp();
db.insert(s.settings)
  .values({ key: "torbox", value: encrypt("release-test-key") })
  .run();
const releases = [
  {
    id: "french",
    language: "French",
    narrator: "French Reader",
    format: "MP3",
    hash: "a".repeat(40),
  },
  {
    id: "english-one",
    language: "English",
    narrator: "Jeff Hays",
    format: "M4B",
    hash: "b".repeat(40),
  },
  {
    id: "english-two",
    language: "English",
    narrator: "Another Reader",
    format: "MP3",
    hash: "c".repeat(40),
  },
];
const listing = (release: (typeof releases)[number]) =>
  `<div class="post"><div class="postTitle"><h2><a href="/abss/${release.id}/">Dungeon Crawler Carl - Matt Dinniman</a></h2></div><div class="postInfo">Category: LitRPG<br>Language: ${release.language}<span>Keywords: Fantasy</span></div><div class="postContent">Shared by: uploader Posted: 20 Oct 2026<br>Format: ${release.format} / Bitrate: 64 Kbps<br>File Size: 500 MBs</div></div>`;
const detail = (release: (typeof releases)[number]) =>
  `<div class="post"><div class="postTitle"><h1>Dungeon Crawler Carl - Matt Dinniman</h1></div><div class="postInfo">Language: ${release.language}<span>Keywords: Fantasy</span></div><div class="postContent"><p>Shared by: uploader</p><div class="desc">Written by <span class="author">Matt Dinniman</span><br>Read by <span class="narrator">${release.narrator}</span><br>Format: <span class="format">${release.format}</span><br>Bitrate: <span class="bitrate">64 Kbps</span><br>Unabridged<p>One complete audiobook release.</p></div><a href="magnet:?xt=urn:btih:${release.hash}">Magnet</a></div></div>`;
const original = globalThis.fetch;
let lastHash = "";
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname.startsWith("audiobookbay.")) {
    if (url.pathname.startsWith("/abss/"))
      return new Response(
        detail(releases.find((release) => url.pathname.includes(release.id))!),
      );
    assert.equal(url.searchParams.get("s"), "dungeon");
    if (url.pathname.includes("/page/2/"))
      return new Response(listing(releases[2]));
    return new Response(
      listing(releases[0]) +
        listing(releases[1]) +
        '<div class="wp-pagenavi"><a href="/page/2/?s=dungeon">2</a></div>',
    );
  }
  assert.equal(url.hostname, "api.torbox.app");
  let data: unknown;
  if (url.pathname.endsWith("checkcached"))
    data = [{ hash: url.searchParams.get("hash") }];
  else if (url.pathname.endsWith("createtorrent")) {
    assert.equal((init!.body as FormData).get("add_only_if_cached"), "true");
    lastHash = magnetHash(String((init!.body as FormData).get("magnet")));
    data = {
      torrent_id:
        900 + releases.findIndex((release) => release.hash === lastHash),
    };
  } else if (url.pathname.endsWith("mylist"))
    data = {
      download_present: true,
      files: [{ id: 1, name: "Complete audiobook.mp3" }],
    };
  else throw new Error("Unexpected provider request");
  return Response.json({ success: true, data });
};
after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
test("release search returns every language and supports subsequent source pages", async () => {
  const first = await app.inject("/api/discover/abb/releases?q=Dungeon");
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(
    first
      .json()
      .results.map((release: { language: string }) => release.language),
    ["French", "English"],
  );
  assert.equal(first.json().results[1].format, "M4B");
  assert.equal(first.json().results[1].size, "500 MBs");
  assert.equal(first.json().nextPage, 2);
  const second = await app.inject(
    "/api/discover/abb/releases?q=dungeon&page=2",
  );
  assert.equal(second.json().results[0].id, "english-two");
  assert.equal(second.json().nextPage, null);
});
test("release details parse source headings without links and expose the actual narrator", async () => {
  const response = await app.inject("/api/discover/abb/releases/english-one");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().narrator, "Jeff Hays");
  assert.equal(response.json().language, "English");
  assert.equal(response.json().title, "Dungeon Crawler Carl");
  assert.equal(response.json().format, "M4B");
});
test("choosing two releases links distinct recordings to one work and preserves independent progress", async () => {
  const choose = (slug: string) =>
    app.inject({
      method: "POST",
      url: "/api/discover/abb/add",
      payload: {
        slug,
        workId: "work-alice",
        title: "Forged title",
        author: "Forged author",
      },
    });
  const first = await choose("english-one");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(lastHash, releases[1].hash);
  assert.equal(first.json().language, "English");
  assert.equal(first.json().narrator, "Jeff Hays");
  const firstBook = listBooks().find(
    (book) => book.id === first.json().bookId,
  )!;
  assert.equal(firstBook.workId, "work-alice");
  assert.equal(firstBook.releaseTitle, "Dungeon Crawler Carl");
  assert.equal(firstBook.narrator, "Jeff Hays");
  await app.inject({
    method: "POST",
    url: "/api/progress",
    payload: {
      recordingId: firstBook.recordingId,
      trackId: firstBook.tracks[0].id,
      position: 45,
      duration: 120,
      updatedAt: Date.now(),
    },
  });
  const second = await choose("english-two");
  assert.equal(second.statusCode, 200, second.body);
  const secondBook = listBooks().find(
    (book) => book.id === second.json().bookId,
  )!;
  assert.equal(secondBook.workId, firstBook.workId);
  assert.notEqual(secondBook.recordingId, firstBook.recordingId);
  assert.equal(secondBook.narrator, "Another Reader");
  assert.equal(secondBook.progress, undefined);
  assert.equal(
    listBooks().find((book) => book.id === firstBook.id)!.progress!.position,
    45,
  );
  assert.equal((await choose("english-one")).json().bookId, firstBook.id);
});
test("legacy empty-JSON library removal succeeds, keeps media/progress and allows re-adding", async () => {
  const before = listBooks().find((book) => book.id === "alice")!;
  const response = await app.inject({
    method: "DELETE",
    url: "/api/library/alice",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const after = listBooks().find((book) => book.id === "alice")!;
  assert.equal(after.inLibrary, false);
  assert.deepEqual(after.tracks, before.tracks);
  assert.deepEqual(after.progress, before.progress);
  assert.ok(
    db
      .select()
      .from(s.hiddenLibrary)
      .where(eq(s.hiddenLibrary.bookId, "alice"))
      .get(),
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/library",
        payload: { bookId: "alice" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    listBooks().find((book) => book.id === "alice")!.inLibrary,
    true,
  );
  const bad = await app.inject({
    method: "POST",
    url: "/api/library",
    headers: { "content-type": "application/json" },
  });
  assert.equal(bad.statusCode, 400); // Required JSON remains required.
});
