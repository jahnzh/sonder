import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-hardcover-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp, listBooks } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { setUserSecret } = await import("../server/users.ts");
const hc = await import("../server/hardcover.ts");
const app = await createApp();
const realFetch = globalThis.fetch;
const queries = new Set<string>();
const audio = {
  id: 901,
  audio_seconds: 21454,
  edition_format: "Audiobook",
  contributions: [
    { contribution: "narrator", author: { name: "Kara Shallenberg" } },
  ],
};
function book(id: number, title: string, author: string) {
  return {
    id,
    title,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    pages: 200,
    description: "A Hardcover edition",
    release_year: 1865,
    cached_image: null,
    contributions: [{ contribution: "author", author: { name: author } }],
    book_series: [],
    default_audio_edition: id === 101 ? audio : null,
    editions: id === 101 ? [audio] : [],
  };
}
const alice = book(101, "Alice’s Adventures in Wonderland", "Lewis Carroll");
const waiting = book(202, "A new reading world", "Ada Author");
const listOnly = book(303, "A weekend story", "Bee Writer");
function read(seconds = 2000) {
  return {
    id: 501,
    started_at: "2026-01-01",
    finished_at: null as string | null,
    finished_at_precision: null as number | null,
    progress_seconds: seconds as number | null,
    progress_pages: null as number | null,
    edition_id: 901,
    edition: {
      id: 901,
      audio_seconds: 21454,
      pages: null as number | null,
      reading_format_id: 2,
    },
  };
}
type Remote = {
  id: number;
  book_id: number;
  status_id: number;
  updated_at: string;
  book: ReturnType<typeof book>;
  user_book_reads: ReturnType<typeof read>[];
};
let user = 41;
let entries: Remote[] = [];
let members: {
  id: number;
  list_id: number;
  book_id: number;
  book: ReturnType<typeof book>;
}[] = [];
let calls: { query: string; variables: Record<string, any> }[] = [];
let failWrites = false,
  failLists = false,
  invalidSnapshot = false,
  concurrentWrite: (() => void) | null = null;
beforeEach(() => {
  hc.resetHardcoverAccount(1);
  db.delete(s.userHiddenLibrary).run();
  db.delete(s.userHardcoverRecordingEditions).run();
  db.delete(s.hardcoverLinks).run();
  db.delete(s.userProgress).run();
  setUserSecret(1, "hardcover", "test-key-not-real");
  user = 41;
  calls = [];
  failWrites = false;
  failLists = false;
  invalidSnapshot = false;
  concurrentWrite = null;
  entries = [
    {
      id: 11,
      book_id: 101,
      status_id: 2,
      updated_at: "2020-01-01T00:00:00Z",
      book: structuredClone(alice),
      user_book_reads: [read()],
    },
    {
      id: 12,
      book_id: 202,
      status_id: 1,
      updated_at: "2020-01-01T00:00:00Z",
      book: structuredClone(waiting),
      user_book_reads: [],
    },
  ];
  members = [
    { id: 71, list_id: 70, book_id: 101, book: structuredClone(alice) },
    { id: 72, list_id: 70, book_id: 303, book: structuredClone(listOnly) },
  ];
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://api.hardcover.app/"))
      return realFetch(input, init);
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer test-key-not-real",
    );
    const { query, variables: v } = JSON.parse(String(init?.body));
    queries.add(query);
    calls.push({ query, variables: v });
    let data: any;
    if (query.includes("SonderSearchLinks")) data = { books: [alice] };
    else if (query.includes("SonderSearch"))
      data = {
        search: {
          results: {
            hits: [
              {
                document: {
                  id: 101,
                  title: alice.title,
                  author_names: ["Lewis Carroll"],
                },
              },
            ],
          },
        },
      };
    else if (query.includes("SonderAccount"))
      data = { me: [{ id: user, username: "test-reader" }] };
    else if (query.includes("SonderLibrary")) {
      assert.equal(v.userId, user);
      data = {
        user_books: invalidSnapshot
          ? null
          : entries.slice(v.offset, v.offset + 250),
      };
    } else if (query.includes("SonderLists")) {
      if (failLists)
        return Response.json({
          errors: [{ message: "read:lists permission required" }],
        });
      data = {
        lists: [
          {
            id: 70,
            user_id: user,
            name: "Weekend stories",
            slug: "weekend-stories",
            books_count: members.length,
          },
        ],
      };
    } else if (query.includes("SonderListBooks"))
      data = {
        list_books: members
          .filter((m) => v.ids.includes(m.list_id))
          .slice(v.offset, v.offset + 500),
      };
    else if (query.includes("SonderListMembership"))
      data = {
        list_books: members
          .filter((m) => m.list_id === v.list && m.book_id === v.book)
          .map(({ id, list_id, book_id }) => ({ id, list_id, book_id })),
      };
    else if (query.includes("SonderListAdd")) {
      const m = {
        id: Math.max(100, ...members.map((m) => m.id)) + 1,
        list_id: v.object.list_id,
        book_id: v.object.book_id,
        book: [alice, waiting, listOnly].find(
          (b) => b.id === v.object.book_id,
        )!,
      };
      members.push(m);
      data = {
        insert_list_book: {
          id: m.id,
          list_book: { id: m.id, list_id: m.list_id, book_id: m.book_id },
        },
      };
    } else if (query.includes("SonderListRemove")) {
      const m = members.find((m) => m.id === v.id);
      members = members.filter((m) => m.id !== v.id);
      data = { delete_list_book: { id: m?.id || null } };
    } else if (query.includes("SonderBookProgress"))
      data = { user_books: entries.filter((e) => e.book_id === v.bookId) };
    else if (query.includes("SonderBook("))
      data = {
        books_by_pk:
          [alice, waiting, listOnly].find((b) => b.id === v.id) || null,
      };
    else if (
      query.includes("SonderShelfUpdate") ||
      query.includes("SonderShelfAdd")
    ) {
      if (failWrites)
        return Response.json({
          errors: [{ message: "Simulated Hardcover outage" }],
        });
      let remote = entries.find((e) =>
        query.includes("SonderShelfUpdate")
          ? e.id === v.id
          : e.book_id === v.object.book_id,
      );
      if (!remote) {
        remote = {
          id: 100 + entries.length,
          book_id: v.object.book_id,
          status_id: v.object.status_id,
          updated_at: new Date().toISOString(),
          book: [alice, waiting, listOnly].find(
            (b) => b.id === v.object.book_id,
          )!,
          user_book_reads: [],
        };
        entries.push(remote);
      }
      remote.status_id = v.object.status_id;
      remote.updated_at = new Date().toISOString();
      if (remote.status_id === 2 && !remote.user_book_reads.length)
        remote.user_book_reads = [read(0)];
      if (remote.status_id === 3 && remote.user_book_reads[0]) {
        remote.user_book_reads[0].finished_at = "2026-10-26";
        remote.user_book_reads[0].progress_seconds = 21454;
      }
      data = query.includes("SonderShelfUpdate")
        ? { update_user_book: { error: null, user_book: remote } }
        : { insert_user_book: { error: null, user_book: remote } };
    } else if (query.includes("SonderReadProgress")) {
      if (failWrites)
        return Response.json({
          errors: [{ message: "Simulated Hardcover outage" }],
        });
      const remote = entries.find((e) =>
        e.user_book_reads.some((r) => r.id === v.id),
      )!;
      const original = remote.user_book_reads[0];
      const obj = v.object;
      const updated = {
        ...original,
        ...obj,
        edition:
          obj.edition_id === 901
            ? {
                id: 901,
                audio_seconds: 21454,
                pages: null,
                reading_format_id: 2,
              }
            : original.edition,
      };
      remote.user_book_reads = [updated];
      remote.updated_at = new Date().toISOString();
      if (concurrentWrite) {
        const fn = concurrentWrite;
        concurrentWrite = null;
        fn();
      }
      data = {
        update_user_book_read: { error: null, user_book_read: updated },
      };
    } else if (query.includes("SonderReadStart")) {
      const remote = entries.find((e) => e.id === v.userBookId)!;
      const next = read(0);
      next.id = 700 + entries.length;
      remote.user_book_reads = [next];
      data = { insert_user_book_read: { error: null, user_book_read: next } };
    } else
      throw new Error("Unexpected Hardcover operation: " + query.slice(0, 70));
    return Response.json({ data: structuredClone(data) });
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  writeFileSync(
    "/tmp/sonder-hardcover-queries.json",
    JSON.stringify([...queries]),
  );
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
function absolute(recordingId = "recording-alice") {
  const p = db
    .select()
    .from(s.userProgress)
    .where(eq(s.userProgress.recordingId, recordingId))
    .get()!;
  const tracks = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.recordingId, recordingId))
    .all()
    .sort((a, b) => a.index - b.index);
  const index = tracks.findIndex((t) => t.id === p.trackId);
  return (
    tracks.slice(0, index).reduce((sum, t) => sum + t.duration, 0) + p.position
  );
}
async function setup(mode: "import" | "two-way" = "two-way") {
  hc.configureHardcover(1, mode, true);
  return hc.syncHardcover(1);
}
async function localPosition(position: number, updatedAt = Date.now()) {
  const result = await app.inject({
    method: "POST",
    url: "/api/progress",
    payload: {
      recordingId: "recording-alice",
      trackId: "alice-0",
      position,
      duration: 640,
      updatedAt,
    },
  });
  assert.equal(result.statusCode, 200, result.body);
  return updatedAt;
}
test("Hardcover shelves, custom lists, matching and imported progress preserve existing media identity", async () => {
  const before = listBooks().find((b) => b.id === "alice")!;
  const summary = await setup("import");
  assert.equal(summary.imported, 2);
  assert.equal(summary.matched, 1);
  const after = listBooks().find((b) => b.id === "alice")!;
  assert.equal(after.workId, before.workId);
  assert.equal(after.recordingId, before.recordingId);
  assert.deepEqual(
    after.tracks.map((t) => t.id),
    before.tracks.map((t) => t.id),
  );
  assert.equal(after.hardcover?.id, 101);
  assert.deepEqual(after.hardcover?.listIds, [70]);
  assert.equal(absolute(), 1000);
  assert.equal(listBooks().find((b) => b.id === "hc-202")!.tracks.length, 0);
  assert.equal(listBooks().find((b) => b.id === "hc-303")!.inLibrary, true);
  assert.equal(hc.hardcoverState(1).lists[0].name, "Weekend stories");
  assert.ok(!calls.some((c) => c.query.startsWith("mutation")));
});
test("two-way listening progress maps to the Hardcover edition duration and preserves read dates and page progress", async () => {
  await setup();
  await localPosition(320);
  const summary = await hc.syncHardcover(1);
  assert.equal(summary.progress, 1);
  const write = calls
    .filter((c) => c.query.includes("SonderReadProgress"))
    .at(-1)!;
  assert.equal(write.variables.object.progress_seconds, 640);
  assert.equal(write.variables.object.edition_id, 901);
  assert.equal(write.variables.object.started_at, "2026-01-01");
  assert.equal(write.variables.object.finished_at, null);
  assert.equal(absolute(), 320);
  assert.equal(hc.hardcoverState(1).pending, 0);
});
test("starting a read and syncing its status does not replace queued listening progress with the new read’s zero position", async () => {
  entries[0].status_id = 1;
  entries[0].user_book_reads = [];
  await setup();
  await localPosition(300);
  const summary = await hc.syncHardcover(1);
  assert.equal(summary.pushed, 1);
  assert.equal(summary.progress, 1);
  assert.equal(entries[0].status_id, 2);
  assert.equal(entries[0].user_book_reads[0].progress_seconds, 600);
  assert.equal(absolute(), 300);
});
test("built-in reading progress publishes overall percentage without changing the recording checkpoint", async () => {
  await setup();
  await localPosition(320);
  hc.queueHardcoverReadingProgress(1, "work-alice", 0.4, "recording-alice");
  assert.equal(absolute(), 320);
  const queued = sqlite
    .prepare("SELECT fraction FROM user_hardcover_reading_outbox")
    .get() as { fraction: number };
  assert.equal(queued.fraction, 0.4);
  await hc.syncHardcover(1);
  assert.equal(entries[0].user_book_reads[0].progress_pages, 80);
  assert.equal(absolute(), 320);
});
test("ebook reading progress syncs without local audio and retries a failed remote write", async () => {
  entries[1].user_book_reads = [
    {
      ...read(),
      id: 2029,
      edition_id: 777,
      progress_seconds: null,
      progress_pages: 0,
      edition: { id: 777, pages: 200, audio_seconds: 0, reading_format_id: 1 },
    },
  ];
  await setup();
  const before = db.select().from(s.userProgress).all();
  const link = db
    .select()
    .from(s.hardcoverLinks)
    .where(eq(s.hardcoverLinks.bookId, 202))
    .get()!;
  hc.queueHardcoverReadingProgress(1, link.workId, 0.25);
  failWrites = true;
  await hc.syncHardcover(1);
  assert.ok(
    sqlite
      .prepare("SELECT error FROM user_hardcover_reading_outbox WHERE book_id=202")
      .get(),
  );
  failWrites = false;
  await hc.syncHardcover(1);
  assert.equal(
    sqlite
      .prepare("SELECT book_id FROM user_hardcover_reading_outbox WHERE book_id=202")
      .get(),
    undefined,
  );
  assert.equal(
    entries.find((entry) => entry.book_id === 202)!.user_book_reads[0]
      .progress_pages,
    50,
  );
  assert.deepEqual(db.select().from(s.userProgress).all(), before);
});
test("finishing an EPUB publishes its final page and a later explicit shelf change clears stale reading work", async () => {
  await setup();
  await localPosition(320);
  hc.queueHardcoverReadingProgress(1, "work-alice", 1);
  await hc.syncHardcover(1);
  assert.equal(entries[0].status_id, 3);
  assert.equal(entries[0].user_book_reads[0].progress_pages, 200);
  assert.equal(absolute(), 320);
  hc.queueHardcoverReadingProgress(1, "work-alice", 0.2);
  hc.queueHardcoverStatus(1, "work-alice", "unread");
  assert.equal(
    sqlite.prepare("SELECT book_id FROM user_hardcover_reading_outbox").get(),
    undefined,
  );
});
test("offline Hardcover changes remain durable and retry without blocking local progress", async () => {
  await setup();
  await localPosition(280);
  failWrites = true;
  const first = await hc.syncHardcover(1);
  assert.equal(first.pending, 1);
  assert.match(db.select().from(s.userHardcoverProgress).get()!.error!, /outage/);
  assert.equal(absolute(), 280);
  failWrites = false;
  await hc.syncHardcover(1);
  assert.equal(hc.hardcoverState(1).pending, 0);
  assert.equal(entries[0].user_book_reads[0].progress_seconds, 560);
});
test("new local progress arriving during a remote write is not removed by an older response", async () => {
  await setup();
  await localPosition(100);
  concurrentWrite = () => {
    const value = {
      recordingId: "recording-alice",
      trackId: "alice-0",
      position: 200,
      duration: 640,
      updatedAt: Date.now() + 5,
    };
    db.insert(s.userProgress)
      .values({ ...value, userId: 1 })
      .onConflictDoUpdate({ target: [s.userProgress.userId, s.userProgress.recordingId], set: value })
      .run();
    hc.queueHardcoverProgress(1, "recording-alice");
  };
  await hc.syncHardcover(1);
  assert.equal(db.select().from(s.userHardcoverProgress).get()!.position, 200);
  await hc.syncHardcover(1);
  assert.equal(hc.hardcoverState(1).pending, 0);
  assert.equal(entries[0].user_book_reads[0].progress_seconds, 400);
});
test("external progress changes can move backward, map across chapters, and never jump to another work", async () => {
  await setup("import");
  entries[0].user_book_reads[0].progress_seconds = 100;
  await hc.syncHardcover(1);
  assert.equal(absolute(), 50);
  const wrong = await app.inject({
    method: "POST",
    url: "/api/hardcover/progress/pull",
    payload: { workId: "work-alice", recordingId: "recording-pride" },
  });
  assert.equal(wrong.statusCode, 400);
  entries[0].user_book_reads[0].progress_seconds = 10000;
  const pull = await app.inject({
    method: "POST",
    url: "/api/hardcover/progress/pull",
    payload: { workId: "work-alice", recordingId: "recording-alice" },
  });
  assert.equal(pull.statusCode, 200, pull.body);
  assert.equal(absolute(), 5000);
  assert.notEqual(pull.json().progress.trackId, "alice-0");
});
test("ebook page progress on Hardcover maps to the local audio percentage", async () => {
  entries[0].user_book_reads = [
    {
      ...read(),
      edition_id: 777,
      progress_seconds: null,
      progress_pages: 50,
      edition: { id: 777, audio_seconds: 0, pages: 200, reading_format_id: 1 },
    },
  ];
  await setup("import");
  assert.equal(absolute(), 10727 * 0.25);
});
test("progress falls back to pages when Hardcover has no audio edition", async () => {
  entries[0].book.default_audio_edition = null;
  entries[0].book.editions = [];
  entries[0].user_book_reads = [
    {
      ...read(),
      edition_id: 777,
      progress_seconds: null,
      progress_pages: 50,
      edition: { id: 777, audio_seconds: 0, pages: 200, reading_format_id: 1 },
    },
  ];
  await setup();
  await localPosition(536.35);
  await hc.syncHardcover(1);
  const write = calls
    .filter((c) => c.query.includes("SonderReadProgress"))
    .at(-1)!;
  assert.equal(write.variables.object.progress_pages, 10);
  assert.equal(write.variables.object.progress_seconds, null);
  assert.equal(write.variables.object.edition_id, 777);
});
test("shelf changes queue and retry, while removing a local library entry never deletes a Hardcover book", async () => {
  await setup();
  hc.setHardcoverShelf(1, "work-alice", 4);
  failWrites = true;
  await hc.syncHardcover(1);
  assert.equal(db.select().from(s.userHardcoverOutbox).get()!.statusId, 4);
  failWrites = false;
  await hc.syncHardcover(1);
  assert.equal(entries[0].status_id, 4);
  const before = calls.length;
  await app.inject({ method: "DELETE", url: "/api/library/alice" });
  assert.ok(!calls.slice(before).some((c) => /delete_user_book/.test(c.query)));
  await hc.syncHardcover(1);
  assert.equal(
    listBooks().find((book) => book.id === "alice")!.inLibrary,
    false,
  );
  const restored = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { bookId: "alice" },
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(
    listBooks().find((book) => book.id === "alice")!.inLibrary,
    true,
  );
});
test("custom list updates are restricted to synced lists owned by the connected account", async () => {
  await setup();
  await assert.rejects(
    hc.setHardcoverListMember(1, 999, "work-alice", true),
    /own Hardcover lists/,
  );
  await hc.setHardcoverListMember(1, 70, "work-alice", false);
  assert.ok(!members.some((m) => m.book_id === 101));
  await hc.setHardcoverListMember(1, 70, "work-alice", true);
  assert.ok(members.some((m) => m.book_id === 101));
  assert.equal(
    listBooks().find((b) => b.id === "alice")!.hardcover?.listIds[0],
    70,
  );
});
test("a failed library or optional lists response preserves the last complete snapshot", async () => {
  await setup("import");
  const count = listBooks().filter((b) => b.inLibrary).length;
  invalidSnapshot = true;
  await assert.rejects(hc.syncHardcover(1), /unexpected response/);
  assert.equal(listBooks().filter((b) => b.inLibrary).length, count);
  invalidSnapshot = false;
  failLists = true;
  await hc.syncHardcover(1);
  assert.equal(hc.hardcoverState(1).lists.length, 1);
  assert.match(hc.hardcoverState(1).listWarning!, /read:lists/);
});
test("unknown durations and a different-account token cannot publish the wrong recording’s position", async () => {
  await setup();
  const track = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.id, "alice-1"))
    .get()!;
  db.update(s.tracks)
    .set({ duration: 0 })
    .where(eq(s.tracks.id, track.id))
    .run();
  await localPosition(100);
  assert.equal(db.select().from(s.userHardcoverProgress).all().length, 0);
  db.update(s.tracks)
    .set({ duration: track.duration })
    .where(eq(s.tracks.id, track.id))
    .run();
  await localPosition(110);
  assert.equal(hc.hardcoverState(1).pending, 1);
  user = 42;
  await assert.rejects(hc.syncHardcover(1), /different Hardcover account/);
  assert.equal(hc.hardcoverState(1).mode, "off");
  assert.equal(hc.hardcoverState(1).pending, 0);
  assert.ok(!calls.some((c) => c.query.includes("SonderReadProgress")));
});
test("a linked current shelf with no open read starts one before saving audio progress", async () => {
  entries[0].user_book_reads = [];
  await setup();
  await localPosition(240);
  await hc.syncHardcover(1);
  assert.ok(calls.some((c) => c.query.includes("SonderReadStart")));
  assert.equal(entries[0].user_book_reads[0].progress_seconds, 480);
});
test("matching and recording edition selection validate the work and preserve local recording identifiers", async () => {
  await setup();
  const id = listBooks().find((b) => b.id === "alice")!.recordingId;
  const match = await app.inject({
    method: "POST",
    url: "/api/hardcover/books",
    payload: { id: 101, workId: "work-alice" },
  });
  assert.equal(match.statusCode, 200, match.body);
  const options = await app.inject(
    "/api/hardcover/editions?workId=work-alice&recordingId=recording-alice",
  );
  assert.equal(options.statusCode, 200, options.body);
  assert.equal(options.json().editions[0].id, 901);
  const wrong = await app.inject({
    method: "PATCH",
    url: "/api/hardcover/edition",
    payload: {
      workId: "work-alice",
      recordingId: "recording-alice",
      editionId: 9999,
    },
  });
  assert.equal(wrong.statusCode, 400);
  const choose = await app.inject({
    method: "PATCH",
    url: "/api/hardcover/edition",
    payload: {
      workId: "work-alice",
      recordingId: "recording-alice",
      editionId: 901,
    },
  });
  assert.equal(choose.statusCode, 200, choose.body);
  assert.equal(listBooks().find((b) => b.id === "alice")!.recordingId, id);
});
test("new audio inherits the remembered Hardcover position when it replaces a metadata-only entry", async () => {
  entries[1].status_id = 2;
  entries[1].user_book_reads = [
    {
      ...read(),
      id: 888,
      edition_id: 777,
      progress_seconds: null,
      progress_pages: 50,
      edition: { id: 777, audio_seconds: 0, pages: 200, reading_format_id: 1 },
    },
  ];
  await setup("import");
  const workId = "work-hc-202";
  const id = "downloaded-hc-recording";
  db.insert(s.editions)
    .values({
      id,
      workId,
      cover: "/covers/time.svg",
      narrator: "Test narrator",
      rating: 0,
      sourceLabel: "Your server",
    })
    .run();
  db.insert(s.recordings).values({ id, editionId: id }).run();
  db.insert(s.tracks)
    .values({
      id,
      recordingId: id,
      title: "Complete recording",
      index: 0,
      duration: 1000,
      source: "/unused-complete-recording.wav",
      sourceType: "local",
    })
    .run();
  db.insert(s.userLibrary)
    .values({ userId: 1, bookId: id, status: "unread", addedAt: Date.now() })
    .run();
  hc.claimHardcoverAudio(workId, id);
  assert.equal(absolute(id), 250);
  assert.equal(
    db.select().from(s.userLibrary).where(eq(s.userLibrary.bookId, "hc-202")).get(),
    undefined,
  );
  assert.equal(
    db.select().from(s.userLibrary).where(eq(s.userLibrary.bookId, id)).get()!.status,
    "listening",
  );
});
test("off mode performs no library requests and discovery search remains available", async () => {
  await assert.rejects(hc.syncHardcover(1), /Choose import or two-way/);
  assert.equal(calls.length, 0);
  const search = await app.inject("/api/discover/hardcover?q=Alice");
  assert.equal(search.statusCode, 200, search.body);
  assert.equal(search.json().hits[0].document.id, 101);
  assert.equal(
    search.json().hits[0].document.url,
    `https://hardcover.app/books/${encodeURIComponent(alice.slug)}`,
  );
  assert.ok(!search.json().hits[0].document.url.endsWith("/101"));
});
test("changing a work match clears pending progress and narration mappings for the old Hardcover book", async () => {
  await setup();
  await hc.setHardcoverRecordingEdition(1, "work-alice", "recording-alice", 901);
  await localPosition(250);
  assert.equal(hc.hardcoverState(1).pending, 1);
  await hc.importHardcoverBook(1, 202, "work-alice");
  assert.equal(db.select().from(s.userHardcoverProgress).all().length, 0);
  assert.equal(db.select().from(s.userHardcoverRecordingEditions).all().length, 0);
  assert.equal(
    db
      .select()
      .from(s.hardcoverLinks)
      .where(eq(s.hardcoverLinks.workId, "work-alice"))
      .get()!.bookId,
    202,
  );
  assert.equal(absolute(), 250);
});
test("enabling two-way sync publishes a newer existing Sonder checkpoint on the first sync", async () => {
  db.update(s.userLibrary)
    .set({ status: "listening" })
    .where(eq(s.userLibrary.bookId, "alice"))
    .run();
  db.insert(s.userProgress)
    .values({
      userId: 1,
      recordingId: "recording-alice",
      trackId: "alice-0",
      position: 320,
      duration: 640,
      updatedAt: Date.now(),
    })
    .run();
  const result = await setup();
  assert.equal(result.progress, 1);
  assert.equal(entries[0].user_book_reads[0].progress_seconds, 640);
  assert.equal(absolute(), 320);
  await hc.syncHardcover(1);
  assert.equal(hc.hardcoverState(1).pending, 0);
});
