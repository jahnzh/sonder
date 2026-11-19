// Acquisition status transitions without HTTP routes, and the media state each write
// leaves behind (issue #395, ADR 0011).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-acquisition-status-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { sqlite, db } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const {
  ACQUISITION_STATUSES,
  ACTIVE_ACQUISITION_STATUSES,
  FINISHED_ACQUISITION_STATUSES,
  isActiveAcquisitionStatus,
  isFinishedAcquisitionStatus,
  setAcquisitionStatus,
  startAcquisitionRecord,
} = await import("../server/acquisition-status.ts");
const { controlAcquisition } = await import("../server/acquisitions.ts");
const { getWorkMediaState, getWorkMediaStates } = await import("../server/work-media-state.ts");
const { copyStatusInDownloadList } = await import("../server/downloads.ts");

after(() => rmSync(temp, { recursive: true, force: true }));

beforeEach(() => {
  for (const table of ["work_media_states", "user_acquisitions", "acquisitions", "tracks", "recordings", "audio_editions", "works"])
    sqlite.exec(`DELETE FROM ${table}`);
  db.insert(s.works)
    .values({ id: "w1", title: "One", author: "A", description: "", genre: "g", year: 2020 })
    .run();
});

function acquisitionRow(id: string, workId: string | null, backend = "local") {
  const hash = id.replaceAll("-", "").padEnd(40, "0").slice(0, 40);
  return {
    id,
    hash,
    magnet: `magnet:?xt=urn:btih:${hash}`,
    backend,
    remoteId: null,
    title: "Release",
    author: "A",
    cover: "/covers/time.svg",
    workId,
    language: null,
    narrator: null,
    progress: 0,
    error: null,
    bookId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function start(userId: number, workId: string | null, backend = "local") {
  const id = randomUUID();
  startAcquisitionRecord(acquisitionRow(id, workId, backend));
  db.insert(s.userAcquisitions).values({ userId, acquisitionId: id }).run();
  return id;
}

const statusOf = (id: string) =>
  db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()?.status;

test("the vocabulary splits into active and finished statuses", () => {
  assert.deepEqual(
    [...ACTIVE_ACQUISITION_STATUSES, ...FINISHED_ACQUISITION_STATUSES].sort(),
    [...ACQUISITION_STATUSES].sort(),
  );
  for (const status of ACQUISITION_STATUSES)
    assert.notEqual(isActiveAcquisitionStatus(status), isFinishedAcquisitionStatus(status), status);
  assert.equal(isActiveAcquisitionStatus("queued"), false);
  assert.equal(isFinishedAcquisitionStatus("queued"), false);
});

test("a new acquisition starts checking and the work reads as queued", () => {
  const id = start(1, "w1");
  assert.equal(statusOf(id), "checking");
  assert.deepEqual(pick(getWorkMediaState(1, "w1")), { state: "queued", acquisitionId: id });
});

const expected: Record<string, { state: string; named: boolean }> = {
  checking: { state: "queued", named: true },
  preparing: { state: "queued", named: true },
  downloading: { state: "queued", named: true },
  paused: { state: "queued", named: true },
  ready: { state: "missing", named: false },
  error: { state: "failed", named: true },
  // Cancelled from Activity (#716): nothing on its way and nothing failed; the work gets audio again from Get audiobook.
  cancelled: { state: "missing", named: false },
};

test("after every status write the media state read is the expected one", () => {
  assert.deepEqual(Object.keys(expected).sort(), [...ACQUISITION_STATUSES].sort());
  const id = start(1, "w1");
  // Every ordered pair of statuses, so each write is checked from every previous status.
  for (const from of ACQUISITION_STATUSES)
    for (const to of ACQUISITION_STATUSES) {
      setAcquisitionStatus(id, from);
      setAcquisitionStatus(id, to, { updatedAt: Date.now() });
      assert.equal(statusOf(id), to);
      assert.deepEqual(
        pick(getWorkMediaState(1, "w1")),
        { state: expected[to].state, acquisitionId: expected[to].named ? id : null },
        `${from} -> ${to}`,
      );
    }
});

test("a status write keeps the other fields it was given and leaves updatedAt alone unless given", () => {
  const id = start(1, "w1");
  setAcquisitionStatus(id, "error", { error: "boom" });
  const row = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()!;
  assert.equal(row.status, "error");
  assert.equal(row.error, "boom");
  assert.equal(row.updatedAt, 1);
});

test("pause and resume move a local download between paused and downloading", async () => {
  const id = start(1, "w1");
  setAcquisitionStatus(id, "downloading", { error: "stale" });
  const calls: [string, unknown][] = [];
  const transmission = (async (method: string, args?: unknown) => {
    calls.push([method, args]);
    return {};
  }) as never;
  assert.deepEqual(await controlAcquisition(id, "pause", 1, { transmission }), { ok: true });
  assert.equal(statusOf(id), "paused");
  assert.equal(db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()?.error, null);
  assert.equal(getWorkMediaState(1, "w1")?.state, "queued");
  assert.deepEqual(await controlAcquisition(id, "resume", 1, { transmission }), { ok: true });
  assert.equal(statusOf(id), "downloading");
  const hash = db.select().from(s.acquisitions).where(eq(s.acquisitions.id, id)).get()!.hash;
  assert.deepEqual(calls, [
    ["torrent-stop", { ids: [hash] }],
    ["torrent-start", { ids: [hash] }],
  ]);
});

test("pause is refused for a finished or remote acquisition", async () => {
  const transmission = (async () => {
    throw new Error("must not be called");
  }) as never;
  const ready = start(1, "w1");
  setAcquisitionStatus(ready, "ready");
  await assert.rejects(controlAcquisition(ready, "pause", 1, { transmission }), /Only active local downloads/);
  const remote = start(1, "w1", "torbox");
  await assert.rejects(controlAcquisition(remote, "resume", 1, { transmission }), /Only active local downloads/);
  assert.equal(statusOf(remote), "checking");
  await assert.rejects(controlAcquisition("missing-id", "pause", 1, { transmission }), /could not be found/);
});

test("retry marks the acquisition failed and starts it again for the user", async () => {
  const id = start(1, "w1");
  setAcquisitionStatus(id, "downloading");
  type Call = { magnet: string; metadata: Record<string, unknown>; status?: string; state?: string };
  const calls: Call[] = [];
  const acquire = (async (magnet: string, metadata: Record<string, unknown>) => {
    calls.push({ magnet, metadata, status: statusOf(id), state: getWorkMediaState(1, "w1")?.state });
    return { restarted: true };
  }) as never;
  assert.deepEqual(await controlAcquisition(id, "retry", 2, { acquire }), { restarted: true });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.status, "error");
  assert.equal(call.state, "failed");
  assert.equal(call.metadata.workId, "w1");
  assert.equal(call.metadata.userId, 2);
  assert.match(call.magnet, /^magnet:/);
});

test("a server copy's status reads in the download list's words", () => {
  assert.equal(copyStatusInDownloadList("queued"), "preparing");
  for (const status of ["downloading", "paused", "ready", "error"])
    assert.equal(copyStatusInDownloadList(status), status);
});

test("reading many works' media states takes the same number of queries as one", () => {
  const ids: string[] = [];
  for (let index = 0; index < 25; index++) {
    const workId = `bulk-${index}`;
    ids.push(workId);
    db.insert(s.works)
      .values({ id: workId, title: workId, author: "A", description: "", genre: "g", year: 2020 })
      .run();
    db.insert(s.editions)
      .values({ id: `e-${workId}`, workId, cover: "", narrator: "N", rating: 0, sourceLabel: "T" })
      .run();
    db.insert(s.recordings).values({ id: `r-${workId}`, editionId: `e-${workId}` }).run();
    if (index % 2)
      db.insert(s.tracks)
        .values({ id: `t-${workId}`, recordingId: `r-${workId}`, title: "c", index: 0, duration: 1, source: "/dev/null", sourceType: "local" })
        .run();
    start(1, workId);
  }
  const count = (fn: () => void) => {
    const original = sqlite.prepare;
    let prepared = 0;
    sqlite.prepare = ((...args: Parameters<typeof original>) => {
      prepared++;
      return original.apply(sqlite, args);
    }) as typeof original;
    try {
      fn();
    } finally {
      sqlite.prepare = original;
    }
    return prepared;
  };
  let many = new Map<string, unknown>();
  const one = count(() => void getWorkMediaStates(1, ids.slice(0, 1)));
  const all = count(() => void (many = getWorkMediaStates(1, ids)));
  assert.equal(all, one);
  assert.ok(all <= 3, `expected at most 3 queries, got ${all}`);
  assert.equal(many.size, 25);
  const states = getWorkMediaStates(1, ids);
  assert.equal(states.get("bulk-1")?.state, "available");
  assert.equal(states.get("bulk-2")?.state, "queued");
  assert.equal(getWorkMediaStates(2, ids).size, 0);
});

function pick(state: ReturnType<typeof getWorkMediaState>) {
  if (!state) return state;
  return { state: state.state, acquisitionId: state.acquisitionId };
}
