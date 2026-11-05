import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

// Env before any server import: storage.ts / db.ts capture paths at load (#214).
const temp = mkdtempSync(join(tmpdir(), "sonder-ebook-set-topk-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const {
  planSamples,
  prefixWords,
  selectAnchors,
} = await import("../server/alignment-anchors.ts");
const { cheapTitleAuthorMatch } = await import("../server/ebook-set-filter.ts");
const {
  evaluateOutlierCheck,
  OUTLIER_MIN_SCORE,
} = await import("../server/ebook-set-outlier.ts");
const { createApp } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const {
  EBOOK_SET_TOP_K,
  evaluateEbookSetMember,
  fetchTopKIntoEbookSet,
  listEbookSetMembers,
  resetEbookSetDeps,
  setEbookSetDeps,
} = await import("../server/ebook-set.ts");
const { readerFixture } = await import("./reader-fixture.ts");

const app = await createApp();

after(() => {
  resetEbookSetDeps();
  rmSync(temp, { recursive: true, force: true });
});

beforeEach(() => {
  resetEbookSetDeps();
});

test("cheapTitleAuthorMatch accepts overlapping title tokens and author surname", () => {
  assert.equal(
    cheapTitleAuthorMatch(
      { title: "Project Hail Mary", author: "Andy Weir" },
      { title: "Project Hail Mary EPUB", authors: ["Andy Weir"] },
    ),
    true,
  );
  assert.equal(
    cheapTitleAuthorMatch(
      { title: "Project Hail Mary", author: "Andy Weir" },
      { title: "Different Book", authors: ["Andy Weir"] },
    ),
    false,
  );
});

test("evaluateOutlierCheck rejects weak matches and accepts forward anchors", () => {
  const fragments = Array.from({ length: 200 }, (_, i) => ({
    words: 12,
    section: Math.floor(i / 20),
  }));
  const words = prefixWords(fragments);
  const tracks = [{ id: "t1", duration: 3600 }];
  const samples = planSamples(tracks).map((sample, i) => ({
    ...sample,
    done: true,
    spokenWords: 40,
    match: {
      fragment: i * 8,
      score: 0.85,
      start: sample.time,
    },
  }));
  const pass = evaluateOutlierCheck(
    samples,
    fragments,
    tracks,
    fragments.map(() => "Sample passage text."),
  );
  assert.equal(pass.passed, true);
  assert.equal(pass.reason, "ok");
  assert.ok(pass.forwardOrder);

  const weak = samples.map((sample) =>
    sample.match
      ? { ...sample, match: { ...sample.match, score: 0.3 } }
      : sample,
  );
  const fail = evaluateOutlierCheck(
    weak,
    fragments,
    tracks,
    fragments.map(() => "Sample passage text."),
  );
  assert.equal(fail.passed, false);
  assert.equal(fail.reason, "insufficient_matches");
});

test("evaluateOutlierCheck requires half of spoken samples at the outlier score", () => {
  const fragments = Array.from({ length: 40 }, () => ({ words: 8, section: 1 }));
  const tracks = [{ id: "t1", duration: 900 }];
  const samples = planSamples(tracks).map((sample) => ({
    ...sample,
    done: true,
    spokenWords: 30,
    match: { fragment: 0, score: 0.2, start: sample.time + 1 },
  }));
  const bad = evaluateOutlierCheck(
    samples,
    fragments,
    tracks,
    fragments.map(() => "Weak match text."),
  );
  assert.equal(bad.passed, false);
  assert.equal(bad.reason, "insufficient_matches");
});

function seedWork(title: string, author: string) {
  const workId = `work-${randomUUID()}`;
  db.insert(schema.works)
    .values({
      id: workId,
      title,
      author,
      description: "",
      genre: "Fiction",
      year: 2020,
    })
    .run();
  return workId;
}

async function seedEpub(workId: string, ebookId: string) {
  const dir = join(temp, "media", "ebooks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${ebookId}.epub`);
  writeFileSync(path, await readerFixture({ script: true }));
  db.insert(schema.ebookEditions)
    .values({ id: ebookId, workId, format: "epub", source: path })
    .run();
  return path;
}

function seedRecording(workId: string, recordingId: string, audioPath: string) {
  const editionId = `edition-${workId}`;
  db.insert(schema.editions)
    .values({
      id: editionId,
      workId,
      cover: "/covers/meditations.svg",
      narrator: "Narrator",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(schema.recordings)
    .values({ id: recordingId, editionId })
    .run();
  db.insert(schema.tracks)
    .values({
      id: randomUUID(),
      recordingId,
      title: "Chapter",
      index: 0,
      duration: 3600,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
}

test("GET /api/works/:workId/ebook-set holds members without server audio", async () => {
  const workId = seedWork("Held Book", "Ada Author");
  const ebookId = `ebook-${randomUUID()}`;
  await seedEpub(workId, ebookId);
  await evaluateEbookSetMember(workId, ebookId, {
    sourceTitle: "Held Book",
    sourceAuthor: "Ada Author",
  });
  const res = await app.inject(`/api/works/${workId}/ebook-set`);
  assert.equal(res.statusCode, 200, res.body);
  const members = res.json().members;
  assert.equal(members.length, 1);
  assert.equal(members[0].status, "held");
  assert.equal(members[0].holdReason, "awaiting_audio");
  assert.equal(members[0].evidence.outlier.reason, "no_spoken_samples");
});

test("reevaluate accepts held members once server audio exists", async () => {
  const workId = seedWork("Anchor Book", "Bob Author");
  const ebookId = `ebook-${randomUUID()}`;
  await seedEpub(workId, ebookId);
  await evaluateEbookSetMember(workId, ebookId);
  assert.equal(listEbookSetMembers(workId)[0].status, "held");
  const audio = join(temp, "media", "audio.mp3");
  mkdirSync(join(temp, "media"), { recursive: true });
  writeFileSync(audio, "audio");
  seedRecording(workId, `rec-${randomUUID()}`, audio);
  let fragment = 0;
  setEbookSetDeps({
    anchorSample: async ({ start }) => {
      const step = fragment;
      fragment += 3;
      return {
        spokenWords: 40,
        match: { fragment: step, score: 0.85, start: start + 1 },
      };
    },
  });
  const reeval = await app.inject({
    method: "POST",
    url: `/api/works/${workId}/ebook-set/reevaluate`,
  });
  assert.equal(reeval.statusCode, 200, reeval.body);
  const member = listEbookSetMembers(workId)[0];
  assert.equal(member.status, "accepted");
  assert.equal(member.evidence.outlier.passed, true);
});

test("evaluateEbookSetMember rejects wrong editions with sample passages", async () => {
  const workId = seedWork("Reject Book", "Dan Author");
  const ebookId = `ebook-${randomUUID()}`;
  await seedEpub(workId, ebookId);
  const audio = join(temp, "media", "reject-audio.mp3");
  writeFileSync(audio, "audio");
  seedRecording(workId, `rec-${randomUUID()}`, audio);
  setEbookSetDeps({
    anchorSample: async ({ start }) => ({
      spokenWords: 40,
      match: { fragment: 1, score: 0.2, start: start + 1 },
    }),
  });
  const result = await evaluateEbookSetMember(workId, ebookId);
  assert.equal(result.status, "rejected");
  assert.equal(result.evidence.outlier.passed, false);
  assert.ok(result.evidence.outlier.samples.length > 0);

  const api = await app.inject(`/api/works/${workId}/ebook-set`);
  const row = api.json().members[0];
  assert.ok("sharedSentenceCount" in row.evidence);
  assert.ok("uniqueSentenceCount" in row.evidence);
  assert.ok("audioSupportedCoverage" in row.evidence);
  assert.ok("language" in row.evidence);
});

test("fetchTopKIntoEbookSet downloads at most five filtered candidates", async () => {
  const workId = seedWork("Top K Book", "Cara Author");
  let saved = 0;
  setEbookSetDeps({
    search: async () => ({
      website: "https://example.test",
      files: Array.from({ length: 8 }, (_, i) => ({
        md5: randomUUID().replace(/-/g, ""),
        source: "libgen" as const,
        title: i < 6 ? `Top K Book vol ${i}` : "Unrelated",
        authors: ["Cara Author"],
        extension: "epub" as const,
        language: "English",
        size: "1 MB",
        year: "2020",
        coverUrl: null,
        url: `https://example.test/${i}`,
      })),
    }),
    save: async (input) => {
      saved++;
      const id = `${input.source}-${input.md5}`;
      const dir = join(temp, "media", "ebooks");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${id}.epub`);
      writeFileSync(path, await readerFixture());
      db.insert(schema.ebookEditions)
        .values({ id, workId: input.workId!, format: "epub", source: path })
        .run();
      return { id, alreadySaved: false };
    },
    anchorSample: async () => ({ spokenWords: 0, match: null }),
  });
  const result = await fetchTopKIntoEbookSet(workId);
  assert.equal(saved, EBOOK_SET_TOP_K);
  assert.equal(result.downloaded.length, EBOOK_SET_TOP_K);
  assert.equal(listEbookSetMembers(workId).length, EBOOK_SET_TOP_K);
});

test("fetchTopKIntoEbookSet keeps other candidates when one save fails", async () => {
  const workId = seedWork("Partial Fail Book", "Cara Author");
  const md5Ok1 = randomUUID().replace(/-/g, "");
  const md5Fail = randomUUID().replace(/-/g, "");
  const md5Ok2 = randomUUID().replace(/-/g, "");
  let saveCalls = 0;
  setEbookSetDeps({
    search: async () => ({
      website: "https://example.test",
      files: [
        {
          md5: md5Ok1,
          source: "libgen" as const,
          title: "Partial Fail Book",
          authors: ["Cara Author"],
          extension: "epub" as const,
          language: "English",
          size: "1 MB",
          year: "2020",
          coverUrl: null,
          url: "https://example.test/0",
        },
        {
          md5: md5Fail,
          source: "libgen" as const,
          title: "Partial Fail Book alt",
          authors: ["Cara Author"],
          extension: "epub" as const,
          language: "English",
          size: "1 MB",
          year: "2020",
          coverUrl: null,
          url: "https://example.test/1",
        },
        {
          md5: md5Ok2,
          source: "libgen" as const,
          title: "Partial Fail Book vol 2",
          authors: ["Cara Author"],
          extension: "epub" as const,
          language: "English",
          size: "1 MB",
          year: "2020",
          coverUrl: null,
          url: "https://example.test/2",
        },
      ],
    }),
    save: async (input) => {
      saveCalls++;
      if (input.md5 === md5Fail) {
        throw new Error("bad mirror");
      }
      const id = `${input.source}-${input.md5}`;
      const dir = join(temp, "media", "ebooks");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${id}.epub`);
      writeFileSync(path, await readerFixture({ script: true }));
      db.insert(schema.ebookEditions)
        .values({ id, workId: input.workId!, format: "epub", source: path })
        .run();
      return { id, alreadySaved: false };
    },
    anchorSample: async () => ({ spokenWords: 0, match: null }),
  });
  const result = await fetchTopKIntoEbookSet(workId);
  assert.equal(saveCalls, 3);
  assert.equal(result.downloaded.length, 2);
  assert.equal(result.failures?.length, 1);
  assert.match(result.failures?.[0] ?? "", /bad mirror/);
  assert.equal(listEbookSetMembers(workId).length, 2);
});

test("selectAnchors outlier gate uses score threshold about 0.5", () => {
  assert.equal(OUTLIER_MIN_SCORE, 0.5);
  const fragments = Array.from({ length: 40 }, () => ({ words: 8, section: 1 }));
  const words = prefixWords(fragments);
  const tracks = [{ id: "t1", duration: 900 }];
  const samples = planSamples(tracks).map((sample, i) => ({
    ...sample,
    done: true,
    spokenWords: 25,
    match: { fragment: i * 3, score: 0.55, start: sample.time },
  }));
  const anchors = selectAnchors(samples, words, tracks, OUTLIER_MIN_SCORE);
  assert.ok(anchors.length >= Math.ceil(samples.length / 2));
});

test("POST /api/ebooks/import registers set member when alignment worker is absent", async () => {
  delete process.env.ALIGNMENT_WORKER_URL;
  delete process.env.ALIGNMENT_WORKER_TOKEN;
  const workId = seedWork("Import Book", "Eve Author");
  const audio = join(temp, "media", "import-audio.mp3");
  mkdirSync(join(temp, "media"), { recursive: true });
  writeFileSync(audio, "audio");
  seedRecording(workId, `rec-${randomUUID()}`, audio);
  const boundary = "sonder-ebook-set-import";
  const epub = await readerFixture({ script: true });
  const res = await app.inject({
    method: "POST",
    url: `/api/ebooks/import?workId=${workId}`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Import.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`,
      ),
      epub,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(res.statusCode, 200, res.body);
  const members = listEbookSetMembers(workId);
  assert.equal(members.length, 1);
  assert.equal(members[0].status, "held");
  assert.equal(members[0].holdReason, "awaiting_worker");
});

test("buildEvidence counts shared sentences once per member epub", async () => {
  const workId = seedWork("Shared Book", "Fran Author");
  const firstId = `ebook-${randomUUID()}`;
  const secondId = `ebook-${randomUUID()}`;
  await seedEpub(workId, firstId);
  await seedEpub(workId, secondId);
  await evaluateEbookSetMember(workId, firstId, { sourceTitle: "Shared Book" });
  const result = await evaluateEbookSetMember(workId, secondId, {
    sourceTitle: "Shared Book alt",
  });
  assert.ok(result.evidence.sharedSentenceCount > 0);
  assert.equal(result.evidence.uniqueSentenceCount, 0);
});
