import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, statSync } from "node:fs";
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
const { extractBook, paragraphsOf, invalidateParsedBook } = await import("../server/reader.ts");
const { parse } = await import("node-html-parser");
const { createAlignment, processAlignments, alignmentJob } =
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
test("the shared block definition counts a chapter's blocks exactly as the server did before it (#69)", () => {
  // The server's paragraphsOf() before the definition was shared. Saved alignment maps and
  // sentence locators number blocks this way, so the shared one must not re-number them.
  const legacy = (root: any) => {
    const blocks = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption";
    const all = root.querySelectorAll(blocks).filter((node: any) => !node.querySelector(blocks));
    return (all.length ? all : [root])
      .map((node: any) => node.text.normalize("NFKC").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  };
  const chapters = [
    `<h1>Title</h1><p>One. Two.</p><p>Three.</p>`,
    `<nav epub:type="toc"><ol><li>Skip</li><li>Notes</li></ol></nav><p><svg><text>Ornament</text></svg></p><p>Story.</p>`,
    `<blockquote><p>Inner.</p><p>Second.</p></blockquote><ul><li><p>Nested item.</p></li><li>Plain item.</li></ul>`,
    `<p> </p><p>\u00a0</p><h2>  Spaced   heading </h2><figcaption>Caption.</figcaption>`,
    `<div>Only loose text.</div>`,
    `<div><p></p></div>`,
    `<pre>Code <b>bold</b> line.</pre><noscript><p>Fallback.</p></noscript><p>After.</p>`,
    `<script>var x = "<p>no</p>";</script><style>p{}</style><section><h3>Part</h3><p>Body ﬁne.</p></section>`,
  ];
  for (const chapter of chapters) {
    const html = `<html><body>${chapter}</body></html>`;
    const prune = (source: string) => {
      const root = parse(source);
      root.querySelectorAll("script,style,nav,svg").forEach((node) => node.remove());
      return root.querySelector("body") || root;
    };
    assert.deepEqual(paragraphsOf(prune(html)), legacy(prune(html)), chapter);
  }
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
test("a bookmark for a missing EPUB file is a temporary 503, while invalid bookmarks stay 400 (N1)", async () => {
  const missing = "reader-missing-file";
  db.insert(s.ebookEditions)
    .values({ id: missing, workId: "work-alice", format: "epub", source: join(temp, "media", "ebooks", "gone.epub") })
    .run();
  const locator = { section: 0, paragraphId: "0:1", progression: 0.01 };
  const post = (edition: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/reader/${edition}/bookmarks`, payload });
  const unavailable = await post(missing, { id: "bookmark-missing", label: "My place", locator });
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  // A Node I/O error (here EISDIR: the source path is a directory) is a 503 too, without the path.
  const directory = join(temp, "media", "ebooks", "not-a-file.epub");
  mkdirSync(directory);
  db.update(s.ebookEditions).set({ source: directory }).where(eq(s.ebookEditions.id, missing)).run();
  const io = await post(missing, { id: "bookmark-missing", label: "My place", locator });
  assert.equal(io.statusCode, 503, io.body);
  assert.doesNotMatch(io.json().error, /EISDIR|not-a-file/);
  assert.equal(io.json().code, undefined);
  assert.equal((await post("reader-never-existed", { id: "bookmark-missing", label: "My place", locator })).statusCode, 404);
  const foreign = await post(id, { id: "bookmark-foreign", label: "My place", locator: { ...locator, paragraphId: "99:99" } });
  assert.equal(foreign.statusCode, 400);
  assert.equal(foreign.json().error, "This bookmark does not belong to this edition.");
  const malformed = await post(id, { id: "short", label: "", locator });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error, "Please check the information you entered.");
  db.delete(s.ebookEditions).where(eq(s.ebookEditions.id, missing)).run();
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
  const fullList = (await app.inject(`/api/alignments?ebookId=${id}`)).json()
    .jobs.find((value: { id: string }) => value.id === job.id);
  const summaryList = (
    await app.inject(`/api/alignments?ebookId=${id}&summary=1`)
  ).json().jobs.find((value: { id: string }) => value.id === job.id);
  assert.ok(fullList.intervals.length > 20, "default list keeps intervals");
  assert.deepEqual(summaryList.intervals, []);
  assert.equal(summaryList.intervalCount, fullList.intervals.length);
  assert.equal(
    summaryList.unverifiedCount,
    fullList.intervals.filter((interval: { verified?: boolean }) => !interval.verified)
      .length,
  );
  assert.ok(
    (await app.inject(`/api/alignments/${job.id}/map`)).json().intervals.length >
      20,
    "/map still returns intervals",
  );
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
  const stale = await app.inject(`/api/alignments/${job.id}/map`);
  assert.equal(stale.statusCode, 410);
  assert.equal(stale.json().code, "alignment_stale");
  assert.match(stale.json().error, /ebook or audio changed/);
  const cancel = await app.inject({
    method: "PATCH",
    url: `/api/alignments/${job.id}`,
    payload: { action: "cancel" },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const cancelled = await app.inject(`/api/alignments/${job.id}/map`);
  assert.equal(cancelled.statusCode, 410);
  assert.equal(cancelled.json().code, "alignment_cancelled");
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
test("a single file without chapter markers is located by narration samples and aligned between anchors", async () => {
  // The previous test closes the shared app.
  const local = await createApp();
  after(() => local.close());
  writeFileSync(file, await readerFixture());
  const book = await extractBook(id);
  const fragments = book.sections.flatMap((section) => section.paragraphs);
  // 30 s of credits, five seconds per sentence, 20 s of closing credits.
  const spoken = (index: number) => 30 + index * 5;
  const duration = spoken(fragments.length) + 20;
  db.insert(s.editions)
    .values({
      id: "alice-single",
      workId: "work-alice",
      cover: "",
      narrator: "Unknown narrator",
      rating: 0,
      sourceLabel: "Local",
    })
    .run();
  db.insert(s.recordings)
    .values({ id: "recording-single", editionId: "alice-single" })
    .run();
  db.insert(s.tracks)
    .values({
      id: "single-0",
      recordingId: "recording-single",
      title: "Alice.m4b",
      index: 0,
      duration,
      source: file,
      sourceType: "local",
    })
    .run();
  const options = (
    await local.inject(
      `/api/alignments/options?ebookId=${id}&recordingId=recording-single`,
    )
  ).json();
  assert.equal(options.anchored, true);
  assert.deepEqual(options.pairings, []);
  process.env.ALIGNMENT_WORKER_URL = "http://alignment.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-private-worker-token";
  let anchors = 0,
    windows = 0,
    hold: Promise<void> | null = null,
    holding!: () => void;
  const held = new Promise<void>((resolve) => (holding = resolve));
  let release!: () => void;
  globalThis.fetch = async (input, init) => {
    const data = JSON.parse(String(init?.body));
    if (String(input).endsWith("/anchor")) {
      anchors++;
      if (anchors === 3 && !hold) {
        hold = new Promise((resolve) => (release = resolve));
        holding();
        await hold;
      }
      const index = Math.max(0, Math.ceil((data.start - 30) / 5));
      if (index >= fragments.length || spoken(index) > data.start + data.duration - 3)
        return Response.json({ match: null, start: data.start, text: "" });
      return Response.json({
        match: { index, score: 0.9, text: "" },
        start: spoken(index),
        text: "word ".repeat(40),
      });
    }
    windows++;
    const step = data.duration / data.fragments.length;
    return Response.json({
      engine: "aeneas-1.7.3",
      elapsedSeconds: 1,
      intervals: data.fragments.map((_: string, index: number) => ({
        index,
        start: data.start + index * step,
        end: data.start + (index + 1) * step,
      })),
    });
  };
  const before = db.select().from(s.progress).all();
  const created = await local.inject({
    method: "POST",
    url: "/api/alignments",
    payload: { ebookId: id, recordingId: "recording-single" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const job = created.json();
  assert.equal(job.mode, "anchored");
  assert.deepEqual(job.pairings, []);
  await held;
  await local.inject({
    method: "PATCH",
    url: `/api/alignments/${job.id}`,
    payload: { action: "pause" },
  });
  release();
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = (await local.inject("/api/alignments")).json().jobs
      .find((value: any) => value.id === job.id);
    if (current.status === "paused" && current.anchoring.samples[2].done) break;
  }
  const paused = (await local.inject(`/api/alignments/${job.id}/map`)).json();
  assert.equal(paused.status, "paused");
  const sampled = paused.anchoring.samples.filter((v: any) => v.done).length;
  assert.equal(sampled, 3);
  await local.inject({
    method: "PATCH",
    url: `/api/alignments/${job.id}`,
    payload: { action: "resume" },
  });
  let map: any;
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    map = (await local.inject(`/api/alignments/${job.id}/map`)).json();
    if (map.anchoring?.stage === "done") break;
  }
  assert.equal(map.status, "partial", map.error);
  assert.equal(
    anchors,
    map.anchoring.samples.length,
    "completed samples are not repeated after resuming",
  );
  assert.equal(windows, map.anchoring.segments.length);
  assert.ok(map.anchoring.anchors.length >= 3);
  assert.ok(map.coverage > 0.9, `coverage ${map.coverage}`);
  assert.equal(map.progress, 1);
  const intro = map.anchoring.flags.find((flag: any) => flag.kind === "intro");
  assert.ok(intro && Math.abs(intro.end - 30) < 6, JSON.stringify(intro));
  assert.ok(map.anchoring.flags.some((flag: any) => flag.kind === "outro"));
  const order = new Map(fragments.map((fragment, i) => [fragment.id, i]));
  for (const [i, interval] of map.intervals.entries()) {
    assert.equal(interval.trackId, "single-0");
    assert.ok(interval.verified === undefined);
    const real = spoken(order.get(interval.paragraphId)!);
    assert.ok(Math.abs(interval.start - real) < 12, `${interval.paragraphId} at ${interval.start}, spoken at ${real}`);
    if (i) assert.ok(interval.start >= map.intervals[i - 1].end - 1e-6);
  }
  assert.deepEqual(db.select().from(s.progress).all(), before);
  const reviewed = await local.inject({
    method: "PATCH",
    url: `/api/alignments/${job.id}`,
    payload: { action: "review" },
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  // Unrelated narration: no sample is found in this EPUB.
  globalThis.fetch = async (input, init) => {
    const data = JSON.parse(String(init?.body));
    return Response.json({ match: null, start: data.start, text: "word ".repeat(40) });
  };
  const rebuilt = await createAlignment(id, "recording-single", undefined, "anchored");
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (["error", "partial"].includes((await local.inject(`/api/alignments/${rebuilt.id}/map`)).json().status)) break;
  }
  const refused = (await local.inject(`/api/alignments/${rebuilt.id}/map`)).json();
  assert.equal(refused.status, "error");
  assert.match(refused.error, /Only 0 of \d+ narration samples were found/);
  db.update(s.tracks)
    .set({ chapters: [{ title: "Down the Rabbit-Hole", start: 0, end: 300 }] })
    .where(eq(s.tracks.id, "alice-0"))
    .run();
  await assert.rejects(
    createAlignment(id, "recording-alice", undefined, "anchored"),
    /chapter markers/,
  );
  globalThis.fetch = original;
});
test("r5: a queued job whose EPUB is gone fails on its own and later jobs still run", async () => {
  const local = await createApp();
  after(() => local.close());
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  const brokenFile = join(temp, "media", "ebooks", "broken.epub");
  writeFileSync(brokenFile, await readerFixture());
  db.insert(s.ebookEditions)
    .values({ id: "broken-edition", workId: "work-alice", format: "epub", source: brokenFile })
    .run();
  // Jobs run newest first, so the broken job is reached before the healthy one.
  const healthy = await createAlignment(id, "recording-single", undefined, "anchored");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const broken = await createAlignment("broken-edition", "recording-single", undefined, "anchored");
  unlinkSync(brokenFile);
  process.env.ALIGNMENT_WORKER_URL = "http://alignment.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-private-worker-token";
  globalThis.fetch = async (_input, init) => {
    const data = JSON.parse(String(init?.body));
    return Response.json({ match: null, start: data.start, text: "" });
  };
  await processAlignments();
  assert.equal(alignmentJob(broken.id).status, "error");
  assert.notEqual(alignmentJob(healthy.id).status, "queued");
  globalThis.fetch = original;
});
test("r5: pausing or cancelling during the last narration sample is not replaced by an error", async () => {
  const local = await createApp();
  after(() => local.close());
  process.env.ALIGNMENT_WORKER_URL = "http://alignment.test";
  process.env.ALIGNMENT_WORKER_TOKEN = "test-private-worker-token";
  for (const action of ["pause", "cancel"] as const) {
    let release!: () => void,
      holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const hold = new Promise<void>((resolve) => (release = resolve));
    // The worker may be called before createAlignment resolves, so find the job by its pair.
    const sampling = () =>
      (sqlite.prepare("SELECT data FROM alignment_jobs").all() as { data: string }[])
        .map((row) => JSON.parse(row.data))
        .find((job) => job.ebookId === id && job.recordingId === "recording-single");
    globalThis.fetch = async (_input, init) => {
      const data = JSON.parse(String(init?.body));
      const remaining = (
        sampling().anchoring.samples as { done?: boolean }[]
      ).filter((sample) => !sample.done).length;
      if (remaining === 1) {
        holding();
        await hold;
      }
      // Mismatched narration: no sample is found in this EPUB.
      return Response.json({ match: null, start: data.start, text: "word ".repeat(40) });
    };
    const job = await createAlignment(id, "recording-single", undefined, "anchored");
    await held;
    await local.inject({
      method: "PATCH",
      url: `/api/alignments/${job.id}`,
      payload: { action },
    });
    release();
    let map: any;
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      map = (await local.inject(`/api/alignments?ebookId=${id}`)).json().jobs.find((value: any) => value.id === job.id);
      if (map.anchoring.samples.every((sample: any) => sample.done)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    map = (await local.inject(`/api/alignments?ebookId=${id}`)).json().jobs.find((value: any) => value.id === job.id);
    assert.ok(map.anchoring.samples.every((sample: any) => sample.done));
    assert.equal(map.status, action === "pause" ? "paused" : "cancelled", map.error);
  }
  globalThis.fetch = original;
});
test("relinking an ebook invalidates the parsed-book cache without modifying file mtime", async () => {
  const local = await createApp();
  after(() => local.close());
  db.insert(s.works)
    .values({
      id: "work-relink-target",
      title: "Target Book",
      author: "Target Author",
      description: "Description",
      genre: "Fiction",
      year: 2026,
    })
    .onConflictDoNothing()
    .run();
  const bookInitial = await extractBook(id);
  assert.equal(bookInitial.workId, "work-alice");
  const mtimeBefore = statSync(file).mtimeMs;
  const res = await local.inject({
    method: "POST",
    url: `/api/reader/${id}/link`,
    payload: { workId: "work-relink-target" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(statSync(file).mtimeMs, mtimeBefore);
  const bookAfter = await extractBook(id);
  assert.equal(bookAfter.workId, "work-relink-target");

  // Restore original workId and invalidate
  invalidateParsedBook(id);
  db.update(s.ebookEditions).set({ workId: "work-alice" }).where(eq(s.ebookEditions.id, id)).run();
});
