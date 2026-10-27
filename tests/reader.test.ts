import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-reader-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { readerFixture } = await import("./reader-fixture.ts");
const { extractBook } = await import("../server/reader.ts");
const { createAlignment, processAlignments } =
  await import("../server/alignment.ts");
const { defaultAppearance } = await import("../src/appearance.ts");
const app = await createApp();
const original = fetch;
after(async () => {
  globalThis.fetch = original;
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
const id = "reader-edition";
const file = join(temp, "media", "ebooks", "reader.epub");
writeFileSync(file, await readerFixture({ script: true }));
db.insert(s.ebookEditions)
  .values({ id, workId: "work-alice", format: "epub", source: file })
  .run();
test("appearance validates importable settings, persists the full palette and rejects arbitrary CSS", async () => {
  const preferences = {
    ...defaultAppearance,
    preset: "light",
    colors: { background: "#fafafa" },
    scale: 1.3,
  };
  const response = await app.inject({
    method: "PUT",
    url: "/api/appearance",
    payload: preferences,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await app.inject("/api/appearance")).json().preset, "light");
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/appearance",
        payload: { colors: { background: "url(javascript:evil)" } },
      })
    ).statusCode,
    400,
  );
});
test("EPUB reading order and sentence offsets are extracted without treating scripts as text", async () => {
  const response = await app.inject(`/api/reader/${id}`);
  assert.equal(response.statusCode, 200, response.body);
  const book = response.json();
  assert.equal(book.sections.length, 2);
  assert.equal(book.sections[0].title, "Down the Rabbit-Hole");
  assert.ok(
    book.sections[0].paragraphs.some(
      (p: any) =>
        p.text ===
        "The curious rabbit carried a watch and hurried past the trees.",
    ),
  );
  assert.doesNotMatch(JSON.stringify(book.sections), /__epubScriptExecuted/);
  assert.equal(book.sections[0].paragraphs[1].blockIndex, 1);
  assert.ok(book.fingerprint);
});
test("reading checkpoints are idempotent, support backward reading and preserve conflicts by revision", async () => {
  const book = await extractBook(id);
  const first = {
    locator: {
      section: 0,
      paragraphId: "0:4",
      progression: 0.1,
      cfi: "epubcfi(/6/2!/4/2)",
    },
    baseRevision: 0,
    eventId: "event-111111",
    deviceId: "device-one",
    updatedAt: Date.now(),
    origin: "reading",
  };
  let response = await app.inject({
    method: "PUT",
    url: `/api/reader/${id}/progress`,
    payload: first,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().checkpoint.revision, 1);
  response = await app.inject({
    method: "PUT",
    url: `/api/reader/${id}/progress`,
    payload: first,
  });
  assert.equal(response.json().duplicate, true);
  const other = await app.inject({
    method: "PUT",
    url: `/api/reader/${id}/progress`,
    payload: { ...first, eventId: "event-222222", deviceId: "device-two" },
  });
  assert.equal(other.statusCode, 409);
  assert.equal(other.json().current.revision, 1);
  response = await app.inject({
    method: "PUT",
    url: `/api/reader/${id}/progress`,
    payload: {
      ...first,
      eventId: "event-333333",
      baseRevision: 1,
      locator: {
        ...first.locator,
        paragraphId: book.sections[0].paragraphs[0].id,
        progression: 0,
      },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().checkpoint.locator.progression, 0);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/reader/${id}/progress`,
        payload: {
          ...first,
          eventId: "event-invalid",
          baseRevision: 2,
          locator: { ...first.locator, paragraphId: "99:0" },
        },
      })
    ).statusCode,
    400,
  );
});
test("bookmarks survive app reopening and deleting one does not change reading progress", async () => {
  const locator = { section: 0, paragraphId: "0:1", progression: 0.01 };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/reader/${id}/bookmarks`,
        payload: { id: "bookmark-12345", label: "My place", locator },
      })
    ).statusCode,
    200,
  );
  const reopened = await createApp();
  try {
    assert.equal(
      (await reopened.inject(`/api/reader/${id}`)).json().bookmarks.length,
      1,
    );
    await reopened.inject({
      method: "DELETE",
      url: `/api/reader/${id}/bookmarks/bookmark-12345`,
    });
    assert.equal(
      (await reopened.inject(`/api/reader/${id}`)).json().checkpoint.revision,
      2,
    );
  } finally {
    await reopened.close();
  }
});
test("local alignment pairs chapters, preserves recording progress and invalidates changed sources", async () => {
  db.update(s.tracks)
    .set({
      chapters: [
        { title: "Down the Rabbit-Hole", start: 0, end: 300 },
        { title: "The Pool of Tears", start: 300, end: 640 },
      ],
    })
    .where(eq(s.tracks.id, "alice-0"))
    .run();
  const { tracks } = await import("../server/schema.ts");
  const all = db
    .select()
    .from(tracks)
    .where(eq(tracks.recordingId, "recording-alice"))
    .all();
  for (const track of all.slice(1))
    db.update(tracks)
      .set({ sourceType: "local", source: file })
      .where(eq(tracks.id, track.id))
      .run();
  const options = (
    await app.inject(
      `/api/alignments/options?ebookId=${id}&recordingId=recording-alice`,
    )
  ).json();
  assert.equal(options.pairings.length, 2);
  assert.equal(options.pairings[1].start, 300);
  process.env.ALIGNMENT_WORKER_URL = "http://alignment.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-private-worker-token";
  globalThis.fetch = async (input, init) => {
    const data = JSON.parse(String(init?.body));
    assert.equal(data.token, "test-private-worker-token");
    if (String(input) === "http://alignment.test/anchor") {
      assert.ok(data.duration <= 30);
      return Response.json({
        match: { index: 9, score: 0.9, text: data.fragments[9] },
      });
    }
    assert.equal(String(input), "http://alignment.test/align");
    return Response.json({
      engine: "aeneas-1.7.3",
      elapsedSeconds: 1,
      intervals: data.fragments.map((_: string, i: number) => ({
        index: i,
        start: data.start + i * 3,
        end: data.start + (i + 1) * 3,
      })),
    });
  };
  const before = db.select().from(s.progress).all();
  const job = await createAlignment(id, "recording-alice");
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = (await app.inject(`/api/alignments/${job.id}/map`)).json();
    if (current.sectionsDone?.length === 2) break;
  }
  const map = (await app.inject(`/api/alignments/${job.id}/map`)).json();
  assert.equal(map.status, "partial");
  assert.ok(map.intervals.length > 20);
  assert.equal(map.intervals[0].verified, undefined);
  assert.deepEqual(db.select().from(s.progress).all(), before);
  const durationBefore = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.id, "alice-0"))
    .get()!.duration;
  db.update(s.tracks)
    .set({ duration: durationBefore + 0.000023 })
    .where(eq(s.tracks.id, "alice-0"))
    .run();
  assert.equal(
    (await app.inject(`/api/alignments/${job.id}/map`)).statusCode,
    200,
    "browser duration rounding must not invalidate an unchanged audio file",
  );
  const reviewed = await app.inject({
    method: "PATCH",
    url: `/api/alignments/${job.id}`,
    payload: { action: "review" },
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.ok(
    reviewed.json().intervals.every((interval: any) => interval.verified),
  );
  const corrected = await app.inject({
    method: "POST",
    url: `/api/alignments/${job.id}/anchors`,
    payload: { paragraphId: "0:0", trackId: "alice-0", start: 22, end: 40 },
  });
  assert.equal(corrected.statusCode, 200, corrected.body);
  assert.equal(
    corrected.json().intervals.find((value: any) => value.paragraphId === "0:0")
      .start,
    22,
  );
  const recovered = await app.inject({
    method: "POST",
    url: "/api/alignments/recover",
    payload: {
      ebookId: id,
      recordingId: "recording-alice",
      trackId: "alice-0",
      position: 50,
    },
  });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().locator.paragraphId, "0:9");
  assert.equal(recovered.json().approximate, true);
  assert.deepEqual(db.select().from(s.progress).all(), before);
  writeFileSync(file, await readerFixture({ language: "fr" }));
  assert.equal(
    (await app.inject(`/api/alignments/${job.id}/map`)).statusCode,
    400,
  );
  db.update(s.editions)
    .set({ language: "English" })
    .where(eq(s.editions.id, "alice"))
    .run();
  await assert.rejects(
    createAlignment(id, "recording-alice"),
    /languages differ/,
  );
  globalThis.fetch = original;
});
test("a paused job reopens durably and resumes its completed worker output without reprocessing it", async () => {
  writeFileSync(file, await readerFixture());
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    const data = JSON.parse(String(init?.body));
    calls++;
    const result = {
      engine: "aeneas-1.7.3",
      elapsedSeconds: 1,
      intervals: data.fragments.map((_: string, index: number) => ({
        index,
        start: data.start + index * 2,
        end: data.start + (index + 1) * 2,
      })),
    };
    writeFileSync(data.output, JSON.stringify(result));
    if (calls === 1) {
      started();
      await gate;
    }
    return Response.json(result);
  };
  const job = await createAlignment(id, "recording-alice");
  await entered;
  await app.inject({
    method: "PATCH",
    url: `/api/alignments/${job.id}`,
    payload: { action: "pause" },
  });
  await app.close();
  const reopened = await createApp();
  try {
    assert.equal(
      (await reopened.inject("/api/alignments"))
        .json()
        .jobs.find((value: any) => value.id === job.id).status,
      "paused",
    );
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await reopened.inject({
      method: "PATCH",
      url: `/api/alignments/${job.id}`,
      payload: { action: "resume" },
    });
    for (let i = 0; i < 100; i++) {
      const current = (
        await reopened.inject(`/api/alignments/${job.id}/map`)
      ).json();
      if (current.sectionsDone?.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const done = (
      await reopened.inject(`/api/alignments/${job.id}/map`)
    ).json();
    assert.equal(done.sectionsDone.length, 2);
    assert.equal(
      calls,
      2,
      "one cached section and one newly processed section",
    );
    assert.equal(done.status, "partial");
  } finally {
    release();
    await reopened.close();
    globalThis.fetch = original;
  }
});
