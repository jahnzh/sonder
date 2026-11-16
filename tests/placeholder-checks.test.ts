// Pins the seven places that decide whether an audio edition is a placeholder (issue #483):
// three in the series removal, three in the Hardcover import, one in the media state
// derivation. Written against the behaviour before the rule "an audio edition is a
// placeholder when none of its recordings has a track" replaced the checks on the `hc-` id
// prefix. Every fixture is one where the two rules agree, as they do on production: a
// placeholder has no track, every other audio edition has one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const temp = mkdtempSync(join(tmpdir(), "sonder-placeholder-checks-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
mkdirSync(join(temp, "media"), { recursive: true });
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const hc = await import("../server/hardcover.ts");
const removal = await import("../server/series-removal.ts");
const { deriveWorkMediaStates, playableWorks } = await import(
  "../server/work-media-derivation.ts"
);
const app = await createApp({ background: { manual: ["series-acquisition"] } });

const author = "Pin Author";
const catalogBook = (id: number, title = `Pinned volume ${id}`) => ({
  id,
  title,
  slug: null,
  description: null,
  release_year: 2020,
  release_date: "2020-01-01",
  cached_image: null,
  contributions: [{ contribution: "author", author: { name: author } }],
  book_series: [{ position: id - 400, series: { id: 61, name: "Pinned Saga" } }],
  editions: [],
});
const seriesBooks = [401, 402].map((id) => catalogBook(id));

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/"))
    throw new Error(`Unexpected external request: ${String(input)}`);
  const { query, variables } = JSON.parse(String(init?.body));
  if (query.includes("SonderSeriesPreview"))
    return Response.json({
      data: {
        series_by_pk: {
          id: 61,
          name: "Pinned Saga",
          books_count: seriesBooks.length,
          author: { name: author },
          book_series: seriesBooks.map((book) => ({ position: book.id - 400, book })),
        },
      },
    });
  if (query.includes("SonderBook("))
    return Response.json({
      data: { books_by_pk: seriesBooks.find((book) => book.id === variables.id) ?? null },
    });
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

let adminSession: string | undefined;
async function adminCookie() {
  if (adminSession) return adminSession;
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: "admin-password" },
  });
  assert.equal(login.statusCode, 200, login.body);
  adminSession = login.cookies[0]!.value;
  return adminSession;
}

async function listener(username: string) {
  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    cookies: { sonder_session: await adminCookie() },
    payload: { username, password: "password1" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "password1" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies[0]!.value;
  const id = (
    await app.inject({ url: "/api/auth/status", cookies: { sonder_session: cookie } })
  ).json().user.id as number;
  return { cookie, id };
}

function addWork(workId: string) {
  db.insert(s.works)
    .values({
      id: workId,
      title: `Title ${workId}`,
      author: `Author ${workId}`,
      description: "",
      genre: "Audiobook",
      year: 2020,
    })
    .run();
}

/** An audio edition with one recording; `tracks` tracks whose files exist under MEDIA_ROOT. */
function addEdition(workId: string, editionId: string, tracks: number) {
  db.insert(s.editions)
    .values({
      id: editionId,
      workId,
      cover: "",
      narrator: "Narrator",
      language: null,
      releaseTitle: `Release ${editionId}`,
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(s.recordings).values({ id: `rec-${editionId}`, editionId }).run();
  for (let index = 0; index < tracks; index++) {
    const source = join(temp, "media", `${editionId}-${index}.mp3`);
    writeFileSync(source, "audio");
    db.insert(s.tracks)
      .values({
        id: `${editionId}-t${index}`,
        recordingId: `rec-${editionId}`,
        title: `Chapter ${index + 1}`,
        index,
        duration: 10,
        chapters: [],
        source,
        sourceType: "local",
      })
      .run();
  }
}

function shelve(userId: number, editionId: string, status = "unread") {
  db.insert(s.userLibrary)
    .values({ userId, bookId: editionId, status, addedAt: Date.now() })
    .run();
}

function shelvedIds(userId: number, editionIds: string[]) {
  return (
    sqlite
      .prepare(
        `SELECT book_id AS id FROM user_library
         WHERE user_id=? AND book_id IN (SELECT value FROM json_each(?)) ORDER BY book_id`,
      )
      .all(userId, JSON.stringify(editionIds)) as { id: string }[]
  ).map((row) => row.id);
}

function editionExists(editionId: string) {
  return !!sqlite.prepare("SELECT 1 FROM audio_editions WHERE id=?").get(editionId);
}

async function saveSeries(bookIds: number[]) {
  const cookie = await adminCookie();
  await app.inject({
    method: "PUT",
    url: "/api/hardcover/token",
    cookies: { sonder_session: cookie },
    payload: { token: "fixture-token" },
  });
  const saved = await app.inject({
    method: "POST",
    url: "/api/series",
    cookies: { sonder_session: cookie },
    payload: { id: 61, bookIds },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const view = (
    await app.inject({ url: "/api/series/61", cookies: { sonder_session: cookie } })
  ).json();
  return (bookId: number) =>
    view.works.find((work: { id: number }) => work.id === bookId).workId as string;
}

// --- Series removal (server/series-removal.ts) -------------------------------------------

test("series removal preview lists a work's real audio editions and not its placeholder", async () => {
  const workOf = await saveSeries([401]);
  const workId = workOf(401);
  assert.ok(editionExists("hc-401"), "saving the series made the Hardcover placeholder");
  addEdition(workId, "real-401", 1);
  shelve(1, "real-401");

  const preview = await app.inject({
    url: "/api/series/61/removal",
    cookies: { sonder_session: await adminCookie() },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  const work = preview.json().works.find((w: { bookId: number }) => w.bookId === 401);
  assert.deepEqual(
    work.audioEditions.map((edition: { editionId: string }) => edition.editionId),
    ["real-401"],
  );

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/61",
    cookies: { sonder_session: await adminCookie() },
    payload: {},
  });
  assert.equal(removed.statusCode, 200, removed.body);
});

test("removing a work with its series deletes its real audio edition and keeps its placeholder", async () => {
  const workOf = await saveSeries([402]);
  const workId = workOf(402);
  assert.ok(editionExists("hc-402"));
  addEdition(workId, "real-402", 1);
  shelve(1, "real-402");

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/61",
    cookies: { sonder_session: await adminCookie() },
    payload: { bookIds: [402] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(
    removed.json().audio.map((edition: { editionId: string; wouldDelete: boolean }) => [
      edition.editionId,
      edition.wouldDelete,
    ]),
    [["real-402", true]],
  );
  assert.equal(editionExists("real-402"), false);
  assert.equal(editionExists("hc-402"), true);
  assert.ok(
    sqlite
      .prepare("SELECT 1 FROM user_hidden_library WHERE user_id=1 AND book_id='hc-402'")
      .get(),
    "the placeholder keeps the Hardcover sync from adding the work back",
  );
});

test("suppressing the Hardcover sync of an unlinked work hides its placeholder, never its audio", () => {
  const hiddenOf = (userId: number, editionIds: string[]) =>
    (
      sqlite
        .prepare(
          `SELECT book_id AS id FROM user_hidden_library
           WHERE user_id=? AND book_id IN (SELECT value FROM json_each(?)) ORDER BY book_id`,
        )
        .all(userId, JSON.stringify(editionIds)) as { id: string }[]
    ).map((row) => row.id);

  // The real edition comes first, so picking any edition would pick it.
  addWork("work-pin-hc");
  addEdition("work-pin-hc", "real-pin-hc", 1);
  addEdition("work-pin-hc", "hc-990001", 0);
  removal.ensureHardcoverSyncSuppressed(1, "work-pin-hc");
  assert.deepEqual(hiddenOf(1, ["real-pin-hc", "hc-990001"]), ["hc-990001"]);

  // Without a Hardcover placeholder, an edition without audio stands in for the work.
  addWork("work-pin-empty");
  addEdition("work-pin-empty", "real-pin-empty", 1);
  addEdition("work-pin-empty", "empty-pin-empty", 0);
  removal.ensureHardcoverSyncSuppressed(1, "work-pin-empty");
  assert.deepEqual(hiddenOf(1, ["real-pin-empty", "empty-pin-empty"]), ["empty-pin-empty"]);

  // A work with only audio hides nothing.
  addWork("work-pin-audio");
  addEdition("work-pin-audio", "real-pin-audio", 1);
  removal.ensureHardcoverSyncSuppressed(1, "work-pin-audio");
  assert.deepEqual(hiddenOf(1, ["real-pin-audio"]), []);
});

// --- Hardcover import (server/hardcover.ts) ----------------------------------------------

test("importing a Hardcover book whose work has audio replaces the placeholder on the shelf", () => {
  const book = catalogBook(7101, "Shelf swap volume");
  hc.applyHardcoverCatalogBook(1, book);
  assert.deepEqual(shelvedIds(1, ["hc-7101"]), ["hc-7101"], "first import shelves a placeholder");
  addEdition("work-hc-7101", "real-7101", 1);

  hc.applyHardcoverCatalogBook(1, book);
  assert.deepEqual(shelvedIds(1, ["hc-7101", "real-7101"]), ["real-7101"]);
});

test("one user's Hardcover placeholder is not listed for another user, while audio is", async () => {
  const owner = await listener("pin-owner");
  const other = await listener("pin-other");
  hc.applyHardcoverCatalogBook(owner.id, catalogBook(7201, "Private shelf volume"));
  assert.ok(editionExists("hc-7201"));
  addWork("work-7202");
  addEdition("work-7202", "real-7202", 1);

  const listed = async (cookie: string) =>
    (
      await app.inject({ url: "/api/books", cookies: { sonder_session: cookie } })
    ).json().map((book: { id: string }) => book.id) as string[];
  const forOther = await listed(other.cookie);
  assert.ok(!forOther.includes("hc-7201"), "another user's placeholder is hidden");
  assert.ok(forOther.includes("real-7202"), "audio outside the library is listed");
  const forOwner = await listed(owner.cookie);
  assert.ok(forOwner.includes("hc-7201"), "the owner sees their placeholder");
  assert.ok(forOwner.includes("real-7202"));
  assert.ok((await listed(await adminCookie())).includes("hc-7201"), "the admin sees it");
});

test("new audio for a linked work takes the place of placeholders on every shelf, not of other audio", async () => {
  const shelf = await listener("pin-shelf");
  const audio = await listener("pin-audio");
  addWork("work-7301");
  sqlite
    .prepare("INSERT INTO hardcover_links(work_id,book_id,slug,series) VALUES('work-7301',7301,'book-7301','[]')")
    .run();
  addEdition("work-7301", "hc-7301", 0);
  addEdition("work-7301", "real-7301a", 1);
  shelve(shelf.id, "hc-7301", "listening");
  shelve(audio.id, "real-7301a");
  addEdition("work-7301", "real-7301b", 1);

  hc.claimHardcoverAudio("work-7301", "real-7301b");
  const ids = ["hc-7301", "real-7301a", "real-7301b"];
  assert.deepEqual(shelvedIds(shelf.id, ids), ["real-7301b"]);
  assert.equal(
    (
      sqlite
        .prepare("SELECT status FROM user_library WHERE user_id=? AND book_id='real-7301b'")
        .get(shelf.id) as { status: string }
    ).status,
    "listening",
    "the new audio keeps the placeholder's shelf status",
  );
  assert.deepEqual(shelvedIds(audio.id, ids), ["real-7301a"]);
});

// --- Media state derivation (server/work-media-derivation.ts) ----------------------------

test("the media state derivation on a bare database handle counts audio, not placeholders", () => {
  addWork("work-7401");
  addEdition("work-7401", "hc-7401", 0);
  addWork("work-7402");
  addEdition("work-7402", "real-7402", 1);
  addWork("work-7403");
  addEdition("work-7403", "hc-7403", 0);
  addEdition("work-7403", "real-7403", 1);
  const workIds = ["work-7401", "work-7402", "work-7403"];
  for (const workId of workIds)
    sqlite
      .prepare(
        "INSERT INTO work_media_states(user_id,work_id,state,hold_reason,updated_at) VALUES(1,?,'missing','unreleased',1)",
      )
      .run(workId);

  // A handle of its own, opened read-only, without the server's database module.
  const bare = new Database(join(process.env.DATA_DIR!, "sonder.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.deepEqual([...playableWorks(bare, workIds)].sort(), ["work-7402", "work-7403"]);
    const states = deriveWorkMediaStates(bare, 1, workIds);
    assert.deepEqual(
      workIds.map((workId) => states.get(workId)?.state),
      ["missing", "available", "available"],
    );
  } finally {
    bare.close();
  }
});
