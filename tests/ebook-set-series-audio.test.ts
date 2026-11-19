import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SeriesAudioCandidate,
  SeriesAudioSearchDeps,
  SeriesVolumeRef,
} from "../server/series-audio.ts";

// Env before any server import: storage.ts / db.ts capture paths at load (#214).
const integrationTemp = mkdtempSync(join(tmpdir(), "sonder-series-audio-integration-"));
process.env.DATA_DIR = join(integrationTemp, "db");
process.env.MEDIA_ROOT = join(integrationTemp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const {
  bareVolumeTitle,
  buildVolumeSearchQueries,
  classifySeriesAudioKind,
  classifyVolumeFromTitle,
  pickAutoAcquireCandidate,
  seriesVolumeRefs,
  stripApostrophes,
  searchVolumeAudioCandidates,
  autoAcquireSeriesVolume,
  autoAcquireSeriesVolumes,
  withProviderRetry,
} = await import("../server/series-audio.ts");
const { chooseBackend } = await import("../server/acquisitions.ts");
const { createApp } = await import("../server/app.ts");
const integrationApp = await createApp();
const { db: integrationDb } = await import("../server/db.ts");
const integrationSchema = await import("../server/schema.ts");

after(() => rmSync(integrationTemp, { recursive: true, force: true }));

test("stripApostrophes and search queries include punctuation-stripped variants", () => {
  const title = "The Butcher\u2019s Masquerade";
  assert.equal(stripApostrophes(title), "The Butchers Masquerade");
  assert.equal(bareVolumeTitle(title), "the butchers masquerade");
  const queries = buildVolumeSearchQueries({
    seriesName: "Dungeon Crawler Carl",
    volumeTitle: title,
    position: 5,
    author: "Matt Dinniman",
  });
  assert.ok(queries.some((query) => query.includes("Butchers Masquerade")));
  assert.ok(queries.some((query) => query.includes("Masquerade Dinniman")));
});

test("classifySeriesAudioKind marks compilations and episodic releases", () => {
  assert.equal(
    classifySeriesAudioKind("Book One (Audio Series Book 1)"),
    "plain",
  );
  assert.equal(
    classifySeriesAudioKind("Dungeon Crawler Carl Books 1-3 Collection"),
    "compilation",
  );
  assert.equal(
    classifySeriesAudioKind("Dungeon Crawler Carl — Full Cast Dramatized"),
    "episodic",
  );
  assert.equal(
    classifySeriesAudioKind("Dungeon Crawler Carl - Immersion Edition"),
    "episodic",
  );
  assert.equal(
    classifySeriesAudioKind("Dungeon Crawler Carl - Immersion Tunnel"),
    "episodic",
  );
  assert.equal(
    classifySeriesAudioKind("The Butchers Masquerade (Dungeon Crawler Carl 05)"),
    "plain",
  );
});

test("series-prefixed volume titles get distinct keys and classify book one releases as volume 1", () => {
  const seriesName = "Test Series";
  const volumes = seriesVolumeRefs(
    [
      { position: 1, title: "Test Series: Book One" },
      { position: 2, title: "Test Series: Book Two" },
    ],
    seriesName,
  );
  assert.equal(volumes[0].key, "book one");
  assert.equal(volumes[1].key, "book two");
  assert.notEqual(volumes[0].key, volumes[1].key);
  assert.equal(
    classifyVolumeFromTitle("Test Series Book 1 Audiobook", volumes, seriesName),
    1,
  );
  const queries = buildVolumeSearchQueries({
    seriesName,
    volumeTitle: "Test Series: Book One",
    position: 1,
    author: "Jane Author",
  });
  assert.ok(queries.some((query) => /book one/i.test(query)));
  assert.ok(!queries.every((query) => query.trim().toLowerCase() === "test series"));
});

test("classifyVolumeFromTitle maps apostrophe-stripped Prowlarr titles to the volume", () => {
  const volumes: SeriesVolumeRef[] = seriesVolumeRefs(
    [
      { position: 1, title: "Dungeon Crawler Carl" },
      { position: 5, title: "The Butcher\u2019s Masquerade" },
    ],
    "Dungeon Crawler Carl",
  );
  assert.equal(
    classifyVolumeFromTitle(
      "The Butchers Masquerade (Dungeon Crawler Carl 05) by Matt Dinniman",
      volumes,
      "Dungeon Crawler Carl",
    ),
    5,
  );
});

test("pickAutoAcquireCandidate prefers plain releases and ignores compilations and episodic", () => {
  const hash = "a".repeat(40);
  const candidates: SeriesAudioCandidate[] = [
    {
      source: "prowlarr",
      id: "1",
      title: "Books 1-3 Box Set",
      kind: "compilation",
      query: "q",
      hash,
    },
    {
      source: "prowlarr",
      id: "2",
      title: "Full Cast Season 1",
      kind: "episodic",
      query: "q",
      hash: "b".repeat(40),
    },
    {
      source: "prowlarr",
      id: "3",
      title: "Plain release",
      kind: "plain",
      query: "q",
      hash,
      cached: true,
    },
  ];
  assert.equal(pickAutoAcquireCandidate(candidates)?.id, "3");
  // Two plain releases: the one read by the narrator AudiobookDB names for the release wins (#721).
  const plain: SeriesAudioCandidate[] = [
    { source: "prowlarr", id: "4", title: "Plain release", kind: "plain", query: "q", hash: "c".repeat(40), narrator: "Someone Else" },
    { source: "prowlarr", id: "5", title: "Plain release", kind: "plain", query: "q", hash: "d".repeat(40), narrator: "Jefferson Mays" },
  ];
  assert.equal(pickAutoAcquireCandidate(plain)?.id, "4", "without what AudiobookDB says, the first stays first");
  assert.equal(pickAutoAcquireCandidate(plain, { narrators: ["Jefferson Mays"], lengthMs: null })?.id, "5");
});

test("withProviderRetry logs errors and returns null after repeated failures", async () => {
  const messages: string[] = [];
  let attempts = 0;
  const result = await withProviderRetry(
    "provider",
    async () => {
      attempts++;
      throw new Error("fetch failed");
    },
    (message) => messages.push(message),
    2,
  );
  assert.equal(result, null);
  assert.equal(attempts, 2);
  assert.ok(messages.some((message) => message.includes("fetch failed")));
});

test("searchVolumeAudioCandidates retries providers and classifies by volume", async () => {
  const volumes = seriesVolumeRefs([
    { position: 5, title: "The Butcher\u2019s Masquerade" },
  ]);
  const logs: string[] = [];
  let abbCalls = 0;
  const hash = "c".repeat(40);
  const candidates = await searchVolumeAudioCandidates(
    volumes[0],
    "Dungeon Crawler Carl",
    "Matt Dinniman",
    volumes,
    {
      abbSearch: (async () => {
        abbCalls++;
        if (abbCalls === 1) throw new Error("fetch failed");
        return {
          results: [
            {
              id: "abb-1",
              title: "The Butchers Masquerade (Dungeon Crawler Carl 05)",
              size: "1 GB",
              format: "M4B",
              narrator: "Jeff Hays",
            },
          ],
          page: 1,
          nextPage: null,
          website: "https://example.test",
        };
      }) as SeriesAudioSearchDeps["abbSearch"],
      prowlarrSearch: (async () => ({
        results: [],
        page: 1,
        nextPage: null,
      })) as SeriesAudioSearchDeps["prowlarrSearch"],
      abbMagnetLink: async () =>
        `magnet:?xt=urn:btih:${hash}&dn=plain`,
      prowlarrMagnetLink: async () => {
        throw new Error("unused");
      },
      cachedHashes: async () => new Set([hash]),
      log: (message) => logs.push(message),
    },
  );
  assert.ok(logs.some((message) => message.includes("fetch failed")));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "plain");
  assert.equal(candidates[0].cached, true);
});

test("autoAcquireSeriesVolume queues acquire for a plain candidate", async () => {
  const { magnetHash } = await import("../server/acquisitions.ts");
  const workId = `work-vol5-${randomUUID()}`;
  integrationDb.insert(integrationSchema.works)
    .values({
      id: workId,
      title: "The Butcher\u2019s Masquerade",
      author: "Matt Dinniman",
      description: "d",
      genre: "g",
      year: 2020,
    })
    .run();

  const hash = (randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")).slice(0, 40);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=plain`;
  const recorded = { magnet: null as string | null };
  await autoAcquireSeriesVolume(
    1,
    {
      seriesName: "Dungeon Crawler Carl",
      author: "Matt Dinniman",
      workId,
      volume: seriesVolumeRefs([
        { position: 5, title: "The Butcher\u2019s Masquerade" },
      ])[0],
      allVolumes: seriesVolumeRefs([
        { position: 5, title: "The Butcher\u2019s Masquerade" },
      ]),
      title: "The Butcher\u2019s Masquerade",
    },
    async (nextMagnet, metadata) => {
      recorded.magnet = nextMagnet;
      const route = await chooseBackend(magnetHash(nextMagnet), true, async () => [
        { hash: magnetHash(nextMagnet) },
      ]);
      if (route !== "torbox-cached") throw new Error(`expected torbox-cached, got ${route}`);
      const acquisitionId = randomUUID();
      integrationDb.insert(integrationSchema.acquisitions)
        .values({
          id: acquisitionId,
          hash: magnetHash(nextMagnet),
          magnet: nextMagnet,
          backend: "torbox",
          remoteId: "1",
          title: metadata.title || "title",
          author: metadata.author || "author",
          cover: "/covers/time.svg",
          workId,
          language: null,
          narrator: null,
          status: "downloading",
          progress: 0,
          error: null,
          bookId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      integrationDb.insert(integrationSchema.userAcquisitions)
        .values({ userId: 1, acquisitionId })
        .run();
    },
    {
      abbSearch: (async () => ({
        results: [],
        page: 1,
        nextPage: null,
        website: "",
      })) as SeriesAudioSearchDeps["abbSearch"],
      prowlarrSearch: (async () => ({
        results: [
          {
            id: "p1",
            title: "The Butchers Masquerade (Dungeon Crawler Carl 05)",
            infoHash: hash,
            size: "1 GB",
            format: "M4B",
          },
        ],
        page: 1,
        nextPage: null,
      })) as SeriesAudioSearchDeps["prowlarrSearch"],
      abbMagnetLink: async () => magnet,
      prowlarrMagnetLink: async () => magnet,
      cachedHashes: async () => new Set([hash]),
    },
  );

  assert.ok(recorded.magnet?.includes(hash));
  const job = integrationDb
    .select()
    .from(integrationSchema.acquisitions)
    .all()
    .find((row) => row.workId === workId);
  assert.ok(job);
  assert.equal(job?.status, "downloading");
});

test("autoAcquireSeriesVolume marks empty_search when only episodic candidates exist", async () => {
  const { getWorkMediaState } = await import("../server/work-media-state.ts");

  const workId = `work-episodic-${randomUUID()}`;
  integrationDb.insert(integrationSchema.works)
    .values({
      id: workId,
      title: "Vol",
      author: "Author",
      description: "d",
      genre: "g",
      year: 2020,
    })
    .run();

  let acquireCalls = 0;
  await autoAcquireSeriesVolume(
    1,
    {
      seriesName: "Series",
      author: "Author",
      workId,
      volume: { position: 1, title: "Vol", key: "vol" },
      allVolumes: [{ position: 1, title: "Vol", key: "vol" }],
      title: "Vol",
    },
    async () => {
      acquireCalls++;
    },
    {
      abbSearch: (async () => ({
        results: [
          {
            id: "e1",
            title: "Vol — Graphic Audio dramatized",
            size: "1 GB",
            format: "M4B",
          },
        ],
        page: 1,
        nextPage: null,
        website: "",
      })) as SeriesAudioSearchDeps["abbSearch"],
      prowlarrSearch: (async () => ({
        results: [],
        page: 1,
        nextPage: null,
      })) as SeriesAudioSearchDeps["prowlarrSearch"],
      abbMagnetLink: async () => `magnet:?xt=urn:btih:${"e".repeat(40)}`,
      prowlarrMagnetLink: async () => {
        throw new Error("unused");
      },
      cachedHashes: async () => new Set(),
    },
  );

  assert.equal(acquireCalls, 0);
  assert.equal(getWorkMediaState(1, workId)?.holdReason, "empty_search");
});

test("autoAcquireSeriesVolumes invokes acquire for a plain series volume", async () => {
  const hash = (randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")).slice(0, 40);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=Book+One`;
  const workId = `work-series-acquire-${randomUUID()}`;
  integrationDb.insert(integrationSchema.works)
    .values({
      id: workId,
      title: "Book One",
      author: "Ada Author",
      description: "d",
      genre: "g",
      year: 2020,
    })
    .run();

  let acquired = false;
  await autoAcquireSeriesVolumes(
    1,
    {
      seriesName: "Audio Series",
      author: "Ada Author",
      volumes: [
        {
          position: 1,
          title: "Audio Series: Book One",
          workId,
          unreleased: false,
        },
      ],
    },
    async () => {
      acquired = true;
      return null as never;
    },
    {
      abbSearch: async () => ({
        results: [],
        page: 1,
        nextPage: null,
        website: "",
      }),
      prowlarrSearch: async () => ({
        results: [
          {
            id: "rel-1",
            title: "Book One (Audio Series Book 1)",
            infoHash: hash,
            size: "500 MB",
            format: "M4B",
          },
        ],
        page: 1,
        nextPage: null,
      }),
      abbMagnetLink: async () => magnet,
      prowlarrMagnetLink: async () => magnet,
      cachedHashes: async () => new Set([hash]),
    },
  );
  assert.ok(acquired);
});
