// The release search and pick of a saved series' book (#205, #223), on AudiobookDB's text ids (#721 part b): the
// series comes from the recorded answers (tests/audiobookdb-fixture.ts), and every release source, magnet and acquire
// is a fake, so nothing reaches AudioBookBay, Prowlarr, TorBox or a provider.
import { test, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-release-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
delete process.env.APP_PASSWORD;

const originalFetch = globalThis.fetch;
// Any request the fixtures do not answer is a defect in the test.
const refuse: typeof fetch = async (input) => {
  throw new Error(`Unexpected external request: ${String(input instanceof Request ? input.url : input)}`);
};
globalThis.fetch = refuse;
const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
const control = createControl();
// The series of these tests: two books by Ada Author, nothing from Open Library.
const SERIES = "sr-test-saga";
const FIRST = "bk-first";
control.series.set(SERIES, {
  id: SERIES,
  name: "Test Saga",
  people: [{ name: "Ada Author", role: { name: "Author" } }],
  books: [
    seriesMember(FIRST, "First volume", "Ada Author", "1", 1, { releaseDate: "2020-01-01" }),
    seriesMember("bk-second", "Second volume", "Ada Author", "2", 2, { releaseDate: "2021-01-01" }),
  ],
});
control.openLibrarySeries.set("test saga", []);
let now = Date.parse("2026-11-19T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control, refuse), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control, refuse), clock });

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const {
  resetSeriesReleaseSearchDeps,
  setSeriesReleaseSearchDeps,
  defaultReleaseSearchQuery,
} = await import("../server/series-release-search.ts");
type SeriesReleaseSearchDeps = import("../server/series-release-search.ts").SeriesReleaseSearchDeps;
const { getWorkMediaState } = await import("../server/work-media-state.ts");
const { magnetHash } = await import("../server/acquisitions.ts");
const {
  resetSeriesAcquisitionDeps,
  setSeriesAcquisitionDeps,
  tickSeriesAcquisition,
  SERIES_ACQUISITION_CANCELLED_ERROR,
} = await import("../server/series-acquisition.ts");
type SeriesAcquisitionDeps = import("../server/series-acquisition.ts").SeriesAcquisitionDeps;
const { encrypt } = await import("../server/security.ts");

// The series loop never ticks on its own here. Save series with searchAudio starts the series search at once
// (enqueueSeriesAcquisition); its fakes below are in place before every save.
const app = await createApp({ background: { manual: ["series-acquisition"] } });

const releasesUrl = `/api/series/${SERIES}/works/${FIRST}/releases`;
const AUTO_RESULT = { id: "abb-auto", title: "First volume M4B", format: "M4B", narrator: "Reader", language: "English" };
// The series search's own AudioBookBay search waits on this gate (opened after each test), so a job a save starts
// stays "searching" while the test runs; once open it offers one candidate for the first volume.
let openAutoSearch!: () => void;
let autoSearchGate: Promise<void>;
let autoAcquireCalls = 0;
const gatedSeriesAudioDeps = (): NonNullable<SeriesAcquisitionDeps["seriesAudioDeps"]> => ({
  abbSearch: async () => {
    await autoSearchGate;
    return { results: [AUTO_RESULT], page: 1, nextPage: null };
  },
  prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
  abbMagnetLink: async () => "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=Auto",
  prowlarrMagnetLink: async () => "",
  cachedHashes: async () => new Set<string>(),
  log: () => {},
});

beforeEach(() => {
  resetSeriesAcquisitionDeps();
  resetSeriesReleaseSearchDeps();
  autoSearchGate = new Promise<void>((resolve) => {
    openAutoSearch = resolve;
  });
  autoAcquireCalls = 0;
  setSeriesAcquisitionDeps({
    seriesAudioDeps: gatedSeriesAudioDeps(),
    fetchEbooks: async () => ({ downloaded: [], skipped: null, failures: [] }),
    acquire: (async () => {
      autoAcquireCalls++;
      throw new Error("auto acquire should not run");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  sqlite.exec("DELETE FROM series_acquisition_jobs");
  sqlite.exec("DELETE FROM user_series_seen_works");
  sqlite.exec("DELETE FROM user_saved_series_works");
  sqlite.exec("DELETE FROM user_saved_series");
  sqlite.exec("DELETE FROM series_catalogue_works");
  sqlite.exec("DELETE FROM series_catalogue");
  sqlite.exec("DELETE FROM work_media_states");
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
  sqlite.exec("DELETE FROM tracks");
  sqlite.exec("DELETE FROM recordings");
  sqlite.exec("DELETE FROM audio_editions WHERE id='local-edition'");
  sqlite.prepare("DELETE FROM users WHERE id > 1").run();
  db.insert(schema.settings)
    .values({ key: "prowlarr", value: encrypt("test-prowlarr-key") })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: encrypt("test-prowlarr-key") } })
    .run();
  setSeriesReleaseSearchDeps({
    abbReleaseSearch: (async (q) => {
      if (q.includes("fail-abb")) throw new Error("abb down");
      return {
        results: [
          {
            id: "abb-first",
            title: "First volume M4B",
            source: "abb" as const,
            format: "M4B",
            size: "500 MB",
            narrator: "Reader One",
            language: "English",
            cached: true,
          },
        ],
        page: 1,
        nextPage: null,
      };
    }) as SeriesReleaseSearchDeps["abbReleaseSearch"],
    prowlarrReleaseSearch: (async (q) => {
      if (q.includes("fail-all")) throw new Error("prowlarr down");
      if (q.includes("fail-prowlarr")) throw new Error("prowlarr down");
      return {
        results: [
          {
            id: "prowlarr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            title: "First volume MP3",
            source: "prowlarr" as const,
            format: "MP3",
            size: "400 MB",
          },
        ],
        page: 1,
        nextPage: null,
      };
    }) as SeriesReleaseSearchDeps["prowlarrReleaseSearch"],
    acquire: async (_magnet, metadata) => {
      const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const existing = db
        .select()
        .from(schema.acquisitions)
        .where(eq(schema.acquisitions.hash, hash))
        .get();
      const id = existing?.id ?? randomUUID();
      const row = {
        id,
        hash,
        magnet: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        backend: "local" as const,
        remoteId: null,
        title: metadata?.title ?? "First volume",
        author: metadata?.author ?? "Ada Author",
        cover: metadata?.cover ?? "",
        workId: metadata?.workId ?? null,
        language: metadata?.language ?? null,
        narrator: metadata?.narrator ?? null,
        status: "checking" as const,
        progress: 0,
        error: null,
        bookId: null,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      db.insert(schema.acquisitions)
        .values(row)
        .onConflictDoUpdate({
          target: schema.acquisitions.hash,
          set: {
            title: row.title,
            author: row.author,
            workId: row.workId,
            error: null,
            updatedAt: row.updatedAt,
          },
        })
        .run();
      db.insert(schema.userAcquisitions)
        .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
        .onConflictDoNothing()
        .run();
      return db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, id)).get()!;
    },
    abbRelease: (async (slug: string) => ({
      id: slug,
      title: "First volume M4B",
      author: "Ada Author",
      language: "English",
      narrator: "Reader One",
      cover: "",
      source: "abb" as const,
      url: "",
      format: "M4B",
      bitrate: null,
      size: "500 MB",
      posted: null,
      uploader: null,
      description: "",
      cached: false,
      seeders: null,
    })) as unknown as SeriesReleaseSearchDeps["abbRelease"],
    abbMagnet: async () =>
      "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=First",
    prowlarrRelease: ((id: string) => ({
      id,
      title: "First volume MP3",
      magnetUrl: "",
      downloadUrl: "",
      infoHash: "c".repeat(40),
    })) as SeriesReleaseSearchDeps["prowlarrRelease"],
    prowlarrMagnet: async () =>
      "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=First",
  });
});

afterEach(async () => {
  // Let a series search the test left waiting finish before the next test resets the tables.
  openAutoSearch();
  await tickSeriesAcquisition();
});

after(async () => {
  globalThis.fetch = originalFetch;
  resetSeriesReleaseSearchDeps();
  await app.close();
});

async function saveSeries(
  bookIds: string[],
  options?: { searchAudio?: boolean; searchEbooks?: boolean },
) {
  const saved = await app.inject({
    method: "POST",
    url: "/api/series",
    payload: { id: SERIES, bookIds, ...options },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  return saved;
}

async function firstWork() {
  const page = await app.inject(`/api/series/${SERIES}`);
  assert.equal(page.statusCode, 200, page.body);
  return page.json().works.find((w: { id: string }) => w.id === FIRST);
}

async function firstWorkId(): Promise<string> {
  const workId = (await firstWork())?.workId;
  assert.equal(workId, `work-abdb-${FIRST}`);
  return workId;
}

async function seedAbbSearch(bookId = FIRST, query = "First volume Ada") {
  const search = await app.inject(
    `/api/series/${SERIES}/works/${bookId}/releases/search?q=${encodeURIComponent(query)}`,
  );
  assert.equal(search.statusCode, 200, search.body);
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check());
}

const jobStatus = () => db.select().from(schema.seriesAcquisitionJobs).get()?.status;

test("defaultReleaseSearchQuery combines title and author", () => {
  assert.equal(defaultReleaseSearchQuery("Vol 1", "Ada Author"), "Vol 1 Ada Author");
  assert.equal(defaultReleaseSearchQuery("Vol 1", null), "Vol 1");
});

test("release search returns configured sources and partial source failure", async () => {
  const saved = await saveSeries([FIRST]);
  assert.equal(saved.statusCode, 200, saved.body);
  const ok = await app.inject(
    `${releasesUrl}/search?q=First%20volume%20Ada`,
  );
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.equal(body.results.length, 2);
  assert.ok(body.results.some((r: { source: string }) => r.source === "abb"));
  assert.ok(body.results.some((r: { source: string }) => r.source === "prowlarr"));

  const partial = await app.inject(
    `${releasesUrl}/search?q=fail-abb%20still`,
  );
  assert.equal(partial.statusCode, 200, partial.body);
  const partialBody = partial.json();
  assert.equal(partialBody.results.length, 1);
  assert.equal(partialBody.sourceErrors.length, 1);
  assert.match(partialBody.sourceErrors[0].error, /abb down/);
});

test("selecting a release queues download for the saved work", async () => {
  const saved = await saveSeries([FIRST]);
  assert.equal(saved.statusCode, 200, saved.body);
  const workId = (await firstWorkId());
  await seedAbbSearch();
  const select = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(select.statusCode, 200, select.body);
  assert.equal(getWorkMediaState(1, workId)?.state, "queued");
  assert.equal(db.select().from(schema.acquisitions).all().length, 1);
});

test("active download requires replacement before a new selection", async () => {
  const saved = await saveSeries([FIRST]);
  assert.equal(saved.statusCode, 200, saved.body);
  const workId = (await firstWorkId());
  const firstId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();

  await seedAbbSearch();
  const blocked = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "active_download");

  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, firstId)).get()
      ?.status,
    "error",
  );
  assert.equal(getWorkMediaState(1, workId)?.state, "queued");
});

test("existing playable audio requires confirmation before another download", async () => {
  const saved = await saveSeries([FIRST]);
  assert.equal(saved.statusCode, 200, saved.body);
  const workId = (await firstWorkId());
  const audioPath = join(temp, "existing.mp3");
  writeFileSync(audioPath, "audio");
  db.insert(schema.editions)
    .values({
      id: "local-edition",
      workId,
      cover: "",
      narrator: "N",
      rating: 0,
      sourceLabel: "Local",
    })
    .run();
  db.insert(schema.recordings).values({ id: "rec-local", editionId: "local-edition" }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-local",
      recordingId: "rec-local",
      title: "Ch",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  // The saved-series flow tracks a work that already has audio (no acquisition, no hold).
  const { trackWorkMediaState } = await import("../server/work-media-state.ts");
  trackWorkMediaState(1, workId);
  assert.equal(getWorkMediaState(1, workId)?.state, "available");

  const blocked = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "existing_audio");

  await seedAbbSearch(FIRST);
  const confirmed = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: {
      source: "abb",
      id: "abb-first",
      confirmExistingAudio: true,
    },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(getWorkMediaState(1, workId)?.state, "available");
  assert.equal(db.select().from(schema.acquisitions).all().length, 1);
  assert.equal(
    db.select().from(schema.tracks).where(eq(schema.tracks.id, "track-local")).get()?.source,
    audioPath,
  );
});

test("release search without Prowlarr secret skips Prowlarr", async () => {
  sqlite.prepare("DELETE FROM settings WHERE key='prowlarr'").run();
  await saveSeries([FIRST]);
  const body = (
    await app.inject(`${releasesUrl}/search?q=First%20volume`)
  ).json();
  assert.equal(body.results.length, 1);
  assert.equal(body.sourceErrors.length, 0);
});

test("release search reports every source failure", async () => {
  await saveSeries([FIRST]);
  const body = (
    await app.inject(`${releasesUrl}/search?q=fail-all%20fail-abb`)
  ).json();
  assert.equal(body.results.length, 0);
  assert.equal(body.sourceErrors.length, 2);
});

test("failed release metadata leaves an active download unchanged", async () => {
  await saveSeries([FIRST]);
  const workId = (await firstWorkId());
  const firstId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();
  setSeriesReleaseSearchDeps({
    abbRelease: async () => {
      throw new Error("abb page gone");
    },
  });
  await seedAbbSearch();
  const failed = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.notEqual(failed.statusCode, 200);
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, firstId)).get()
      ?.status,
    "downloading",
  );
});

test("failed release lookup leaves inflight auto-acquire unchanged", async () => {
  await saveSeries([FIRST], { searchAudio: true });
  // The series search the save started waits on its AudioBookBay search.
  await waitFor(() => jobStatus() === "searching");
  const jobBefore = db.select().from(schema.seriesAcquisitionJobs).get();
  setSeriesReleaseSearchDeps({
    abbRelease: async () => {
      throw new Error("abb page gone");
    },
  });
  await seedAbbSearch();
  const failed = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.notEqual(failed.statusCode, 200);
  const jobAfter = db.select().from(schema.seriesAcquisitionJobs).get();
  assert.equal(jobAfter?.status, jobBefore?.status);
  assert.notEqual(jobAfter?.error, SERIES_ACQUISITION_CANCELLED_ERROR);
  // The series search goes on to its own pick.
  openAutoSearch();
  await tickSeriesAcquisition();
  assert.equal(autoAcquireCalls, 1);
});

test("release search succeeds from AudioBookBay when Prowlarr fails", async () => {
  await saveSeries([FIRST]);
  const body = (
    await app.inject(
      `${releasesUrl}/search?q=fail-prowlarr%20First%20volume`,
    )
  ).json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].source, "abb");
  assert.equal(body.sourceErrors.length, 1);
  assert.equal(body.sourceErrors[0].source, "prowlarr");
});

test("replacing a TorBox download returns a detach note", async () => {
  await saveSeries([FIRST]);
  const workId = (await firstWorkId());
  const torboxId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: torboxId,
      hash: magnetHash(magnet),
      magnet,
      backend: "torbox",
      remoteId: "remote-1",
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: torboxId }).run();
  setSeriesReleaseSearchDeps({
    abbMagnet: async () =>
      "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Other",
  });
  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const body = replaced.json();
  assert.equal(body.replaceResult?.action, "detached_torbox");
  assert.match(body.replaceResult?.note ?? "", /TorBox/i);
});

test("replacing with the same hash does not stop the active download", async () => {
  await saveSeries([FIRST]);
  const workId = (await firstWorkId());
  const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const firstId = randomUUID();
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=First`;
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
      hash,
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();
  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().replaceResult?.action, "skipped_same_hash");
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, firstId)).get()
      ?.status,
    "downloading",
  );
});

test("shared active acquisition detaches this user without stopping the job", async () => {
  await saveSeries([FIRST]);
  const workId = (await firstWorkId());
  sqlite.prepare("INSERT INTO users(id,username,role,password_hash,created_at) VALUES(2,'other','user','x',?)").run(Date.now());
  const sharedId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: sharedId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: sharedId }).run();
  db.insert(schema.userAcquisitions).values({ userId: 2, acquisitionId: sharedId }).run();
  setSeriesReleaseSearchDeps({
    abbMagnet: async () =>
      "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Other",
  });
  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().replaceResult?.action, "detached_shared");
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, sharedId)).get()
      ?.status,
    "downloading",
  );
  assert.equal(
    db.select().from(schema.userAcquisitions).where(eq(schema.userAcquisitions.userId, 1)).all()
      .length,
    1,
  );
  assert.ok(
    db
      .select()
      .from(schema.userAcquisitions)
      .where(eq(schema.userAcquisitions.acquisitionId, sharedId))
      .all().length >= 1,
  );
});

test("manual select cancels inflight auto-acquire before the ticker runs", async () => {
  await saveSeries([FIRST], { searchAudio: true });
  await waitFor(() => jobStatus() === "searching");
  await seedAbbSearch();
  const selected = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  const view = await firstWork();
  assert.equal(view.acquisition?.audio?.status, "done");
  assert.equal(view.acquisition?.audio?.error, null);
  // The series search's candidate arrives after the pick: it is not acquired.
  openAutoSearch();
  await tickSeriesAcquisition();
  assert.equal(autoAcquireCalls, 0);
  assert.equal(jobStatus(), "done");
});

test("manual select wins over searching auto-acquire mid-flight", async () => {
  await saveSeries([FIRST], { searchAudio: true });
  const tickRunning = tickSeriesAcquisition();
  await waitFor(() => jobStatus() === "searching");
  await seedAbbSearch();
  const selected = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  openAutoSearch();
  await tickRunning;
  assert.equal(autoAcquireCalls, 0);
  assert.equal(jobStatus(), "done");
});

test("manual select claim blocks ticker while manual acquire is pending", async () => {
  let unblockManualAcquire!: () => void;
  const manualAcquireBlocked = new Promise<void>((resolve) => {
    unblockManualAcquire = resolve;
  });
  let manualAcquireCalls = 0;
  setSeriesReleaseSearchDeps({
    acquire: (async (magnet, metadata) => {
      manualAcquireCalls++;
      await manualAcquireBlocked;
      const hash = magnetHash(magnet);
      const id = randomUUID();
      db.insert(schema.acquisitions)
        .values({
          id,
          hash,
          magnet,
          backend: "local",
          remoteId: null,
          title: metadata?.title ?? "First volume",
          author: metadata?.author ?? "Ada Author",
          cover: "",
          workId: metadata?.workId ?? null,
          language: null,
          narrator: null,
          status: "checking",
          progress: 0,
          error: null,
          bookId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      db.insert(schema.userAcquisitions)
        .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
        .run();
      return db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, id)).get()!;
    }) as SeriesReleaseSearchDeps["acquire"],
  });
  await saveSeries([FIRST], { searchAudio: true });
  const tickRunning = tickSeriesAcquisition();
  await waitFor(() => jobStatus() === "searching");
  await seedAbbSearch();
  const selectRunning = app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  await waitFor(() => manualAcquireCalls === 1);
  // The series search finishes while the manual acquire is still pending.
  openAutoSearch();
  await new Promise((resolve) => setTimeout(resolve, 50));
  unblockManualAcquire();
  const selected = await selectRunning;
  assert.equal(selected.statusCode, 200, selected.body);
  await tickRunning;
  assert.equal(autoAcquireCalls, 0);
  assert.equal(manualAcquireCalls, 1);
  assert.equal(
    db.select().from(schema.acquisitions).all().length,
    1,
  );
});

test("replace failure after acquire finalizes claim and does not reopen auto-acquire", async () => {
  await saveSeries([FIRST], { searchAudio: true });
  await waitFor(() => jobStatus() === "searching");
  const workId = (await firstWorkId());
  const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const firstId = randomUUID();
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=First`;
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
      hash,
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();
  setSeriesReleaseSearchDeps({
    replacePreviousAcquisition: async () => {
      throw new Error("replace blew up");
    },
  });
  await seedAbbSearch();
  const selected = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.notEqual(selected.statusCode, 200);
  assert.equal(jobStatus(), "done");
  openAutoSearch();
  await tickSeriesAcquisition();
  assert.equal(autoAcquireCalls, 0);
  assert.equal(jobStatus(), "done");
});

test("concurrent manual selects for the same work are mutually exclusive", async () => {
  await saveSeries([FIRST]);
  let unblockManualAcquire!: () => void;
  const manualAcquireBlocked = new Promise<void>((resolve) => {
    unblockManualAcquire = resolve;
  });
  let manualAcquireCalls = 0;
  const defaultAcquire = (async (_magnet: string, metadata: { userId?: number; title?: string; author?: string; workId?: string }) => {
    manualAcquireCalls++;
    await manualAcquireBlocked;
    const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const id = randomUUID();
    db.insert(schema.acquisitions)
      .values({
        id,
        hash,
        magnet: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        backend: "local",
        remoteId: null,
        title: metadata?.title ?? "First volume",
        author: metadata?.author ?? "Ada Author",
        cover: "",
        workId: metadata?.workId ?? null,
        language: null,
        narrator: null,
        status: "checking",
        progress: 0,
        error: null,
        bookId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    db.insert(schema.userAcquisitions)
      .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
      .run();
    return db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, id)).get()!;
  }) as SeriesReleaseSearchDeps["acquire"];
  setSeriesReleaseSearchDeps({ acquire: defaultAcquire });
  await seedAbbSearch();
  const first = app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  await waitFor(() => manualAcquireCalls === 1);
  const second = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "select_in_progress");
  unblockManualAcquire();
  const firstResult = await first;
  assert.equal(firstResult.statusCode, 200, firstResult.body);
  assert.equal(manualAcquireCalls, 1);
});

test("manual select is rejected while ticker auto-acquire is in flight for the same work", async () => {
  let unblockAutoAcquire!: () => void;
  const autoAcquireBlocked = new Promise<void>((resolve) => {
    unblockAutoAcquire = resolve;
  });
  let manualAcquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      autoAcquireCalls++;
      await autoAcquireBlocked;
      throw new Error("auto acquire stub");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  setSeriesReleaseSearchDeps({
    acquire: (async () => {
      manualAcquireCalls++;
      throw new Error("manual acquire stub");
    }) as SeriesReleaseSearchDeps["acquire"],
  });
  await saveSeries([FIRST], { searchAudio: true });
  const tickRunning = tickSeriesAcquisition();
  await waitFor(() => jobStatus() === "searching");
  openAutoSearch();
  await waitFor(() => autoAcquireCalls > 0);
  assert.equal(autoAcquireCalls, 1);
  await seedAbbSearch();
  const manual = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(manual.statusCode, 409);
  assert.equal(manual.json().code, "select_in_progress");
  assert.equal(manualAcquireCalls, 0);
  unblockAutoAcquire();
  await tickRunning;
});

test("a failed magnet fetch does not block a later manual select", async () => {
  await saveSeries([FIRST]);
  let magnetCalls = 0;
  setSeriesReleaseSearchDeps({
    abbMagnet: async () => {
      magnetCalls++;
      if (magnetCalls === 1) throw new Error("magnet down");
      return "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=First";
    },
  });
  await seedAbbSearch();
  const failed = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.notEqual(failed.statusCode, 200);
  await seedAbbSearch();
  const retry = await app.inject({
    method: "POST",
    url: `${releasesUrl}/select`,
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(retry.statusCode, 200, retry.body);
});
