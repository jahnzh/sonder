// A recording for a new book (#576, spec #572 "What the server answers and accepts"): `POST /api/discover/abb/add`
// and `POST /api/discover/prowlarr/add` with `makeWork: true` and no `workId` make a work from the release, its
// placeholder and a row in the requesting administrator's library, then acquire with that work; the answer carries
// its `workId`, and the import of the finished download replaces the placeholder (`claimWorkAudio`). Through the app
// instance on a throwaway database. AudioBookBay, Prowlarr and TorBox are fixtures: nothing is ever downloaded.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-new-book-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { refreshAcquisition } = await import("../server/acquisitions.ts");
const { acquireForNewBook } = await import("../server/new-book.ts");
const { isPlaceholderEdition } = await import("../server/placeholder-edition.ts");

// The download loop never ticks here: each test refreshes the acquisition itself.
const app = await createApp({ background: { manual: ["acquisitions"] } });

const ABB_HASH = "a".repeat(40);
const PROWLARR_HASH = "b".repeat(40);
const COVER = "https://covers.fixture.test/lamplighter.jpg";
const detail = (hash: string) =>
  `<div class="post"><div class="postTitle"><h1>The Lamplighter’s Atlas - Ada Author</h1></div><div class="postInfo">Language: English<span>Keywords: Fantasy</span></div><div class="postContent"><p>Shared by: uploader</p><img itemprop="image" src="${COVER}"><div class="desc">Written by <span class="author">Ada Author</span><br>Read by <span class="narrator">Reader One</span><br>Format: <span class="format">M4B</span><br>Bitrate: <span class="bitrate">64 Kbps</span><p>One release.</p></div><a href="magnet:?xt=urn:btih:${hash}">Magnet</a></div></div>`;

/** TorBox has the files once `finished` is set: until then the download is on its way. */
let finished = false;
let torrentId = 700;
const fetched: string[] = [];
const original = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  fetched.push(`${url.hostname}${url.pathname}`);
  if (url.hostname.startsWith("audiobookbay.")) {
    const slug = /\/abss\/([^/]+)\//.exec(url.pathname)?.[1] ?? "";
    return new Response(detail(slug.replace(/^rec-/, "")));
  }
  if (url.origin === "http://prowlarr.fixture.test:9696") {
    if (url.pathname === "/api/v1/search")
      return Response.json([
        {
          guid: `https://tracker.test/${PROWLARR_HASH}`,
          indexerId: 1,
          indexer: "Tracker",
          title: "The Quiet Orchard [Unabridged] (M4B)",
          size: 400_000_000,
          seeders: 9,
          publishDate: "2026-09-01T00:00:00Z",
          categories: [{ id: 3030, name: "Audio/Audiobook" }],
          protocol: "torrent",
          infoHash: PROWLARR_HASH,
          magnetUrl: `magnet:?xt=urn:btih:${PROWLARR_HASH}`,
        },
      ]);
    return new Response("", { status: 404 });
  }
  if (url.hostname === "api.torbox.app") {
    let data: unknown;
    if (url.pathname.endsWith("checkcached")) data = [];
    else if (url.pathname.endsWith("createtorrent")) data = { torrent_id: torrentId++ };
    else if (url.pathname.endsWith("mylist"))
      data = finished
        ? { download_present: true, files: [{ id: 1, name: "Atlas/01.mp3", short_name: "01.mp3" }, { id: 2, name: "Atlas/02.mp3", short_name: "02.mp3" }] }
        : { download_present: false, files: [] };
    else throw new Error(`Unexpected TorBox request: ${url}`);
    return Response.json({ success: true, data });
  }
  throw new Error(`Unexpected external request: ${url}`);
};

db.insert(s.settings).values({ key: "torbox", value: encrypt("new-book-key") }).run();
db.insert(s.settings).values({ key: "prowlarr", value: encrypt("fixture-prowlarr-key") }).run();
db.insert(s.settings).values({ key: "prowlarrUrl", value: "http://prowlarr.fixture.test:9696" }).run();

const login = async (username: string | undefined, password: string) => {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(response.statusCode, 200, response.body);
  return response.cookies[0].value;
};
const admin = await login(undefined, "admin-password");
const created = await app.inject({
  method: "POST",
  url: "/api/users",
  cookies: { sonder_session: admin },
  payload: { username: "listener", password: "password1" },
});
assert.equal(created.statusCode, 200, created.body);
const listenerId = created.json().id as number;
const listener = await login("listener", "password1");

after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
});

beforeEach(() => {
  finished = false;
  fetched.length = 0;
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
});

const as = (cookie: string) => ({ cookies: { sonder_session: cookie } });
const works = () => db.select().from(s.works).all();
const editionsOf = (workId: string) => db.select().from(s.editions).where(eq(s.editions.workId, workId)).all();
const libraryRows = (userId: number, workId: string) =>
  sqlite
    .prepare("SELECT l.book_id AS bookId,l.status FROM user_library l JOIN audio_editions e ON e.id=l.book_id WHERE l.user_id=? AND e.work_id=?")
    .all(userId, workId) as { bookId: string; status: string }[];

async function prowlarrId(cookie = admin) {
  const search = await app.inject({ url: "/api/discover/prowlarr/releases?q=quiet%20orchard", ...as(cookie) });
  assert.equal(search.statusCode, 200, search.body);
  return (search.json().results as { id: string }[])[0].id;
}

/** Adds through one of the two routes with `makeWork`, as the administrator. */
async function addNew(route: "abb" | "prowlarr", extra: Record<string, unknown> = {}) {
  if (route === "abb")
    return app.inject({ method: "POST", url: "/api/discover/abb/add", ...as(admin), payload: { slug: `rec-${ABB_HASH}`, makeWork: true, ...extra } });
  return app.inject({ method: "POST", url: "/api/discover/prowlarr/add", ...as(admin), payload: { id: await prowlarrId(), makeWork: true, ...extra } });
}

for (const route of ["abb", "prowlarr"] as const) {
  const title = route === "abb" ? "The Lamplighter’s Atlas" : "The Quiet Orchard";

  test(`${route}: makeWork makes one work, one placeholder and one library row, and the acquisition carries the workId`, async () => {
    const before = works().length;
    const response = await addNew(route);
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    // The answer is the acquisition, with the new work's id.
    assert.equal(typeof job.workId, "string");
    assert.equal(job.status, "preparing");
    assert.equal(db.select().from(s.acquisitions).where(eq(s.acquisitions.id, job.id)).get()?.workId, job.workId);
    // One work, from the release.
    assert.equal(works().length, before + 1);
    const work = db.select().from(s.works).where(eq(s.works.id, job.workId)).get()!;
    assert.equal(work.title, title);
    assert.equal(work.author, route === "abb" ? "Ada Author" : "Unknown author");
    // One placeholder, with the release's cover (AudioBookBay names one; Prowlarr does not).
    const editions = editionsOf(job.workId);
    assert.equal(editions.length, 1);
    assert.ok(isPlaceholderEdition(sqlite, editions[0].id));
    assert.equal(editions[0].cover, route === "abb" ? COVER : "/covers/meditations.svg");
    // One library row, the administrator's; the other account has none.
    assert.deepEqual(libraryRows(1, job.workId), [{ bookId: editions[0].id, status: "unread" }]);
    assert.deepEqual(libraryRows(listenerId, job.workId), []);
    // The acquisition is the administrator's only.
    assert.deepEqual(
      db.select().from(s.userAcquisitions).where(eq(s.userAcquisitions.acquisitionId, job.id)).all().map((row) => row.userId),
      [1],
    );

    // The book is in the Library (by work) before the download ends.
    const library = await app.inject({ url: "/api/library", ...as(admin) });
    assert.equal(library.statusCode, 200, library.body);
    const listed = (library.json() as { workId: string; inLibrary: boolean; mediaState?: { state?: string } | null }[]).find(
      (entry) => entry.workId === job.workId,
    );
    assert.equal(listed?.inLibrary, true);
    assert.equal(listed?.mediaState?.state, "queued");
    // Not in the other account's library.
    const theirs = await app.inject({ url: "/api/library", ...as(listener) });
    assert.equal(theirs.statusCode, 200, theirs.body);
    assert.equal((theirs.json() as { workId: string }[]).some((entry) => entry.workId === job.workId), false);

    // The download ends: its import replaces the placeholder with the real edition.
    finished = true;
    await refreshAcquisition(job.id);
    const done = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, job.id)).get()!;
    assert.equal(done.status, "ready");
    const after = editionsOf(job.workId);
    const real = after.find((edition) => edition.id === done.bookId)!;
    assert.ok(real, "the real edition is the work's");
    assert.equal(isPlaceholderEdition(sqlite, real.id), false);
    assert.deepEqual(libraryRows(1, job.workId), [{ bookId: real.id, status: "unread" }]);
    assert.deepEqual(libraryRows(listenerId, job.workId), []);
    // No second work was made by the import.
    assert.equal(works().length, before + 1);
  });

  test(`${route}: without makeWork the add is today's: no work is made and the acquisition names none`, async () => {
    const before = works().length;
    const response = await (route === "abb"
      ? app.inject({ method: "POST", url: "/api/discover/abb/add", ...as(admin), payload: { slug: `rec-${ABB_HASH}` } })
      : app.inject({ method: "POST", url: "/api/discover/prowlarr/add", ...as(admin), payload: { id: await prowlarrId() } }));
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    assert.equal(job.workId, null);
    assert.equal(works().length, before);
    // Today's answer: the acquisition row and nothing more.
    assert.deepEqual(Object.keys(job).sort(), Object.keys(db.select().from(s.acquisitions).where(eq(s.acquisitions.id, job.id)).get()!).sort());
    // makeWork: false is the same.
    sqlite.exec("DELETE FROM user_acquisitions");
    sqlite.exec("DELETE FROM acquisitions");
    const off = await addNew(route, { makeWork: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().workId, null);
    assert.equal(works().length, before);
  });

  test(`${route}: makeWork beside a workId gets the recording for that book, as today`, async () => {
    const workId = `work-known-${route}`;
    db.insert(s.works).values({ id: workId, title: "Known", author: "Someone", description: "", genre: "", year: 2020 }).run();
    const before = works().length;
    const response = await addNew(route, { workId });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().workId, workId);
    assert.equal(works().length, before);
  });

  test(`${route}: makeWork is refused for someone who is not the administrator, before anything is fetched or written`, async () => {
    const id = route === "prowlarr" ? await prowlarrId(admin) : null;
    fetched.length = 0;
    const before = works().length;
    const response = await app.inject({
      method: "POST",
      url: `/api/discover/${route}/add`,
      ...as(listener),
      payload: route === "abb" ? { slug: `rec-${ABB_HASH}`, makeWork: true } : { id, makeWork: true },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(fetched, []);
    assert.equal(works().length, before);
    assert.equal(db.select().from(s.acquisitions).all().length, 0);
  });
}

test("the same recording got twice makes one book: the second answer carries the first one's work", async () => {
  const before = works().length;
  const first = await addNew("abb");
  assert.equal(first.statusCode, 200, first.body);
  const second = await addNew("abb");
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().id, first.json().id);
  assert.equal(second.json().workId, first.json().workId);
  assert.equal(works().length, before + 1);
  assert.equal(libraryRows(1, first.json().workId).length, 1);
});

test("a torrent on its way for no book becomes the new book's", async () => {
  const plain = await app.inject({ method: "POST", url: "/api/discover/abb/add", ...as(admin), payload: { slug: `rec-${ABB_HASH}` } });
  assert.equal(plain.statusCode, 200, plain.body);
  assert.equal(plain.json().workId, null);
  const made = await addNew("abb");
  assert.equal(made.statusCode, 200, made.body);
  assert.equal(made.json().id, plain.json().id);
  const workId = made.json().workId;
  assert.equal(db.select().from(s.acquisitions).where(eq(s.acquisitions.id, plain.json().id)).get()?.workId, workId);
  finished = true;
  await refreshAcquisition(made.json().id);
  const bookId = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, made.json().id)).get()?.bookId;
  assert.equal(editionsOf(workId).find((edition) => edition.id === bookId)?.workId, workId);
});

test("a refused acquisition leaves no book behind", async () => {
  const before = works().length;
  const placeholders = db.select().from(s.editions).all().length;
  const libraries = db.select().from(s.userLibrary).all().length;
  await assert.rejects(
    acquireForNewBook(`magnet:?xt=urn:btih:${"c".repeat(40)}`, { title: "Refused", author: "Nobody" }, 1, async () => {
      throw new Error("The torrent client is not working.");
    }),
    /not working/,
  );
  assert.equal(works().length, before);
  assert.equal(db.select().from(s.editions).all().length, placeholders);
  assert.equal(db.select().from(s.userLibrary).all().length, libraries);
  assert.equal(db.select().from(s.userWorkLibraryOrigin).all().filter((row) => !works().some((work) => work.id === row.workId)).length, 0);
});
