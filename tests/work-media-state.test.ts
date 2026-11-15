// Characterisation of a work's media state for a user (issue #395, ADR 0011).
// Written against the stored-cache implementation first; the same assertions must hold
// once the state is derived on read.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-work-media-state-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
delete process.env.APP_PASSWORD;

const { sqlite, db } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const media = await import("../server/work-media-state.ts");
const { listBooks } = await import("../server/app.ts");
const { getWorkMediaState, setWorkMediaHold, markWorkEmptySearch, clearWorkMediaHold } = media;

/**
 * The old cache was only current after a writer refreshed it. Writers that change an
 * acquisition or the tracks called `syncWorkMediaState`; this mirrors that refresh while
 * it exists and is a no-op once the state is derived on read.
 */
function refreshLikeTheWriters(userId: number, workId: string) {
  const sync = (media as Record<string, unknown>).syncWorkMediaState as
    | ((userId: number, workId: string) => unknown)
    | undefined;
  sync?.(userId, workId);
}

after(() => rmSync(temp, { recursive: true, force: true }));

beforeEach(() => {
  for (const table of [
    "work_media_states",
    "user_acquisitions",
    "acquisitions",
    "series_acquisition_jobs",
    "user_series_seen_works",
    "user_hidden_library",
    "user_saved_series_works",
    "user_saved_series",
    "series_catalogue_works",
    "series_catalogue",
    "user_library",
    "tracks",
    "recordings",
    "audio_editions",
    "works",
  ])
    sqlite.exec(`DELETE FROM ${table}`);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(2,'second',NULL,'user',?)",
    )
    .run(Date.now());
});

function addWork(workId: string) {
  db.insert(s.works)
    .values({
      id: workId,
      title: `Title ${workId}`,
      author: "Author",
      description: "",
      genre: "Audiobook",
      year: 2020,
    })
    .run();
}

function addEdition(
  workId: string,
  editionId: string,
  recordings: { id: string; tracks: number }[] = [],
) {
  db.insert(s.editions)
    .values({
      id: editionId,
      workId,
      cover: "/covers/time.svg",
      narrator: "Narrator",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  for (const recording of recordings) {
    db.insert(s.recordings).values({ id: recording.id, editionId }).run();
    for (let index = 0; index < recording.tracks; index++)
      db.insert(s.tracks)
        .values({
          id: `${recording.id}-t${index}`,
          recordingId: recording.id,
          title: "Chapter",
          index,
          duration: 1,
          source: "/dev/null",
          sourceType: "local",
        })
        .run();
  }
}

function addAcquisition(
  userIds: number[],
  workId: string | null,
  status: string,
  updatedAt = Date.now(),
) {
  const id = randomUUID();
  db.insert(s.acquisitions)
    .values({
      id,
      hash: id.replaceAll("-", ""),
      magnet: `magnet:?xt=urn:btih:${id.replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
      backend: "local",
      title: "Release",
      author: "Author",
      cover: "/covers/time.svg",
      workId,
      status,
      progress: 0,
      createdAt: updatedAt,
      updatedAt,
    })
    .run();
  for (const userId of userIds)
    db.insert(s.userAcquisitions).values({ userId, acquisitionId: id }).run();
  return id;
}

function setStatus(id: string, status: string) {
  db.update(s.acquisitions)
    .set({ status, updatedAt: Date.now() })
    .where(eq(s.acquisitions.id, id))
    .run();
}

// --- Presence: when a user's work has a media state at all -------------------------------

test("a library work with audio but no acquisition and no hold has no media state", () => {
  addWork("w-lib");
  addEdition("w-lib", "e-lib", [{ id: "r-lib", tracks: 2 }]);
  db.insert(s.userLibrary)
    .values({ userId: 1, bookId: "e-lib", status: "unread", addedAt: 1 })
    .run();
  assert.equal(getWorkMediaState(1, "w-lib"), null);
  const book = listBooks(1).find((row) => row.workId === "w-lib");
  assert.ok(book?.inLibrary);
  assert.equal(book.mediaState, null);
});

test("a saved-series work with no acquisition and no hold has no media state", () => {
  addWork("w-series");
  addEdition("w-series", "hc-series");
  sqlite.prepare("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(91,'Saga','Author',1)").run();
  sqlite.prepare("INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,91,1)").run();
  sqlite
    .prepare(
      "INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(1,91,9101,'w-series',1)",
    )
    .run();
  assert.equal(getWorkMediaState(1, "w-series"), null);
});

test("a user's acquisition for the work gives that user a media state, not other users", () => {
  addWork("w-acq");
  const id = addAcquisition([1], "w-acq", "downloading");
  refreshLikeTheWriters(1, "w-acq");
  assert.deepEqual(
    pick(getWorkMediaState(1, "w-acq")),
    { state: "queued", holdReason: null, acquisitionId: id },
  );
  assert.equal(getWorkMediaState(2, "w-acq"), null);
});

test("an acquisition without a work id gives no work a media state", () => {
  addWork("w-none");
  addAcquisition([1], null, "downloading");
  assert.equal(getWorkMediaState(1, "w-none"), null);
});

test("a library work with an acquisition reports its media state in the library list", () => {
  addWork("w-lib-acq");
  addEdition("w-lib-acq", "e-lib-acq", [{ id: "r-lib-acq", tracks: 1 }]);
  db.insert(s.userLibrary)
    .values({ userId: 1, bookId: "e-lib-acq", status: "unread", addedAt: 1 })
    .run();
  addAcquisition([1], "w-lib-acq", "ready");
  refreshLikeTheWriters(1, "w-lib-acq");
  const book = listBooks(1).find((row) => row.workId === "w-lib-acq");
  assert.equal(book?.mediaState?.state, "available");
  // A library entry of another user without an acquisition stays null.
  db.insert(s.userLibrary)
    .values({ userId: 2, bookId: "e-lib-acq", status: "unread", addedAt: 1 })
    .run();
  assert.equal(listBooks(2).find((row) => row.workId === "w-lib-acq")?.mediaState, null);
});

test("a hold gives the work a media state that keeps the hold reason", () => {
  addWork("w-hold");
  setWorkMediaHold(1, "w-hold", "unreleased");
  assert.deepEqual(pick(getWorkMediaState(1, "w-hold")), {
    state: "missing",
    holdReason: "unreleased",
    acquisitionId: null,
  });
  markWorkEmptySearch(2, "w-hold");
  assert.equal(getWorkMediaState(2, "w-hold")?.holdReason, "empty_search");
  assert.equal(getWorkMediaState(1, "w-hold")?.holdReason, "unreleased");
});

test("clearing a hold keeps the media state and drops the reason", () => {
  addWork("w-clear");
  markWorkEmptySearch(1, "w-clear");
  clearWorkMediaHold(1, "w-clear");
  assert.deepEqual(pick(getWorkMediaState(1, "w-clear")), {
    state: "missing",
    holdReason: null,
    acquisitionId: null,
  });
});

test("clearing a hold that was never set still starts tracking the work", () => {
  addWork("w-clear-new");
  clearWorkMediaHold(1, "w-clear-new");
  assert.equal(getWorkMediaState(1, "w-clear-new")?.state, "missing");
});

// --- State after each acquisition status and track change ---------------------------------

for (const status of ["checking", "preparing", "downloading", "paused"])
  test(`an acquisition that is ${status} makes the work queued`, () => {
    addWork("w-active");
    const id = addAcquisition([1], "w-active", status);
    refreshLikeTheWriters(1, "w-active");
    assert.deepEqual(pick(getWorkMediaState(1, "w-active")), {
      state: "queued",
      holdReason: null,
      acquisitionId: id,
    });
  });

test("an acquisition in error makes the work failed and names it", () => {
  addWork("w-error");
  const id = addAcquisition([1], "w-error", "error");
  refreshLikeTheWriters(1, "w-error");
  assert.deepEqual(pick(getWorkMediaState(1, "w-error")), {
    state: "failed",
    holdReason: null,
    acquisitionId: id,
  });
});

test("a ready acquisition without tracks leaves the work missing", () => {
  addWork("w-ready");
  addAcquisition([1], "w-ready", "ready");
  refreshLikeTheWriters(1, "w-ready");
  assert.deepEqual(pick(getWorkMediaState(1, "w-ready")), {
    state: "missing",
    holdReason: null,
    acquisitionId: null,
  });
});

test("the user's most recently updated acquisition decides the state", () => {
  addWork("w-latest");
  addAcquisition([1], "w-latest", "error", 1_000);
  const newer = addAcquisition([1], "w-latest", "downloading", 2_000);
  addAcquisition([2], "w-latest", "error", 3_000);
  refreshLikeTheWriters(1, "w-latest");
  assert.deepEqual(pick(getWorkMediaState(1, "w-latest")), {
    state: "queued",
    holdReason: null,
    acquisitionId: newer,
  });
});

test("a status sequence moves the state through queued, failed and queued again", () => {
  addWork("w-seq");
  const id = addAcquisition([1, 2], "w-seq", "checking");
  const seen: string[] = [];
  for (const status of ["checking", "preparing", "downloading", "paused", "downloading", "error", "checking", "ready"]) {
    setStatus(id, status);
    refreshLikeTheWriters(1, "w-seq");
    refreshLikeTheWriters(2, "w-seq");
    seen.push(getWorkMediaState(1, "w-seq")!.state);
    assert.equal(getWorkMediaState(2, "w-seq")?.state, getWorkMediaState(1, "w-seq")?.state);
  }
  assert.deepEqual(seen, ["queued", "queued", "queued", "queued", "queued", "failed", "queued", "missing"]);
});

test("tracks on a recording make the work available whatever the acquisition says", () => {
  addWork("w-tracks");
  const id = addAcquisition([1], "w-tracks", "error");
  setWorkMediaHold(1, "w-tracks", "empty_search");
  refreshLikeTheWriters(1, "w-tracks");
  assert.deepEqual(pick(getWorkMediaState(1, "w-tracks")), {
    state: "failed",
    holdReason: "empty_search",
    acquisitionId: id,
  });
  addEdition("w-tracks", "e-tracks", [{ id: "r-tracks", tracks: 1 }]);
  refreshLikeTheWriters(1, "w-tracks");
  assert.deepEqual(pick(getWorkMediaState(1, "w-tracks")), {
    state: "available",
    holdReason: null,
    acquisitionId: null,
  });
});

test("removing the last track takes the state back to the acquisition's", () => {
  addWork("w-untrack");
  addEdition("w-untrack", "e-untrack", [{ id: "r-untrack", tracks: 1 }]);
  const id = addAcquisition([1], "w-untrack", "downloading");
  refreshLikeTheWriters(1, "w-untrack");
  assert.equal(getWorkMediaState(1, "w-untrack")?.state, "available");
  db.delete(s.tracks).where(eq(s.tracks.recordingId, "r-untrack")).run();
  refreshLikeTheWriters(1, "w-untrack");
  assert.deepEqual(pick(getWorkMediaState(1, "w-untrack")), {
    state: "queued",
    holdReason: null,
    acquisitionId: id,
  });
});

test("Hardcover placeholder editions and empty recordings do not count as audio", () => {
  addWork("w-hc");
  addEdition("w-hc", "hc-123", [{ id: "r-hc", tracks: 1 }]);
  addEdition("w-hc", "e-empty", [{ id: "r-empty", tracks: 0 }]);
  setWorkMediaHold(1, "w-hc", "unreleased");
  assert.equal(media.workHasPlayableAudio("w-hc"), false);
  assert.equal(getWorkMediaState(1, "w-hc")?.state, "missing");
});

test("only an edition's first recording is checked for tracks", () => {
  addWork("w-second");
  addEdition("w-second", "e-second", [
    { id: "r-second-a", tracks: 0 },
    { id: "r-second-b", tracks: 1 },
  ]);
  assert.equal(media.workHasPlayableAudio("w-second"), false);
  addEdition("w-second", "e-second-2", [{ id: "r-second-c", tracks: 1 }]);
  assert.equal(media.workHasPlayableAudio("w-second"), true);
});

test("a queued work is reported by workHasActiveQueuedAcquisition", () => {
  addWork("w-q");
  const id = addAcquisition([1], "w-q", "paused");
  refreshLikeTheWriters(1, "w-q");
  assert.equal(media.workHasActiveQueuedAcquisition(1, "w-q"), true);
  setStatus(id, "error");
  refreshLikeTheWriters(1, "w-q");
  assert.equal(media.workHasActiveQueuedAcquisition(1, "w-q"), false);
  assert.equal(media.workHasActiveQueuedAcquisition(2, "w-q"), false);
});

function pick(state: ReturnType<typeof getWorkMediaState>) {
  if (!state) return state;
  return {
    state: state.state,
    holdReason: state.holdReason,
    acquisitionId: state.acquisitionId,
  };
}

// --- Presence from the series audio flow ------------------------------------------------

const { autoAcquireSeriesVolume, seriesVolumeRefs } = await import("../server/series-audio.ts");
type SeriesAudioSearchDeps = import("../server/series-audio.ts").SeriesAudioSearchDeps;

function volumeInput(workId: string) {
  const refs = seriesVolumeRefs([{ position: 1, title: "Volume One" }]);
  return {
    seriesName: "Saga",
    author: "Author",
    workId,
    volume: refs[0],
    allVolumes: refs,
    title: "Volume One",
  };
}

function oneCandidateDeps(hash: string): SeriesAudioSearchDeps {
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=one`;
  return {
    abbSearch: (async () => ({ results: [], page: 1, nextPage: null, website: "" })) as SeriesAudioSearchDeps["abbSearch"],
    prowlarrSearch: (async () => ({
      results: [{ id: "p1", title: "Saga 01 Volume One", infoHash: hash, size: "1 GB", format: "M4B" }],
      page: 1,
      nextPage: null,
    })) as SeriesAudioSearchDeps["prowlarrSearch"],
    abbMagnetLink: async () => magnet,
    prowlarrMagnetLink: async () => magnet,
    cachedHashes: async () => new Set([hash]),
    log: () => {},
  };
}

test("the series audio flow tracks a work that already has audio", async () => {
  addWork("w-series-audio");
  addEdition("w-series-audio", "e-series-audio", [{ id: "r-series-audio", tracks: 1 }]);
  let called = false;
  const result = await autoAcquireSeriesVolume(1, volumeInput("w-series-audio"), async () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal((result as { state?: string } | null)?.state, "available");
  assert.equal(getWorkMediaState(1, "w-series-audio")?.state, "available");
  assert.equal(getWorkMediaState(2, "w-series-audio"), null);
});

test("the series audio flow tracks a work whose acquire threw before starting", async () => {
  addWork("w-series-throw");
  const hash = "ab".repeat(20);
  const result = await autoAcquireSeriesVolume(
    1,
    volumeInput("w-series-throw"),
    async () => {
      throw new Error("refused");
    },
    oneCandidateDeps(hash),
  );
  assert.equal((result as { state?: string } | null)?.state, "missing");
  assert.deepEqual(pick(getWorkMediaState(1, "w-series-throw")), {
    state: "missing",
    holdReason: null,
    acquisitionId: null,
  });
});

// --- Presence after removing a work with its saved series ---------------------------------

const { removeSavedHardcoverSeries } = await import("../server/series-removal.ts");

test("removing a work with its series leaves the work tracked as missing", async () => {
  addWork("w-removed");
  addEdition("w-removed", "hc-removed");
  db.insert(s.userLibrary)
    .values({ userId: 1, bookId: "hc-removed", status: "unread", addedAt: 1 })
    .run();
  sqlite.prepare("INSERT INTO series_catalogue(id,name,author,book_count) VALUES(92,'Gone','Author',1)").run();
  sqlite
    .prepare(
      "INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,unreleased) VALUES(92,9201,'w-removed','Gone 1',1,0)",
    )
    .run();
  sqlite.prepare("INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,92,1)").run();
  sqlite
    .prepare(
      "INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(1,92,9201,'w-removed',1)",
    )
    .run();
  assert.equal(getWorkMediaState(1, "w-removed"), null);
  await removeSavedHardcoverSeries(1, 92, [9201]);
  assert.deepEqual(pick(getWorkMediaState(1, "w-removed")), {
    state: "missing",
    holdReason: null,
    acquisitionId: null,
  });
});
