// The alignment worker hosts on the Activity page (#357 PR 3): each host's row (online, current job, code
// version), the restart (refused while the host runs work or cannot be read, unless forced; the result on the row)
// and the per-host disable switch the pool honours. The hosts are the in-process fake workers
// (tests/fake-book-worker.ts: real HTTP on 127.0.0.2, fake SSH): no SSH, no real host, and the restart command is
// recorded, never run.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readerFixture } from "./reader-fixture.ts";
import { fakeBookWorkers, type FakeBookJob } from "./fake-book-worker.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-worker-hosts-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
process.env.ALIGNMENT_BOOK_JOBS = "1";
delete process.env.TRANSMISSION_RPC_URL;
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const ebookPath = join(process.env.MEDIA_ROOT, "book.epub");
writeFileSync(ebookPath, await readerFixture({ bodies: ["<p>First sentence. Another sentence.</p>", "<p>Middle sentence. Last sentence.</p>"] }));

const fake = await fakeBookWorkers(join(temp, "hosts"));
process.env.ALIGNMENT_POOL_HOSTS = JSON.stringify(fake.poolHosts());

const pool = await import("../server/alignment-pool.ts");
const { getAlignmentPoolCoordinator, resetAlignmentPoolStatusCache, setAlignmentPoolDepsForTests, acquireWorkerLease, PoolBusyError } = pool;
setAlignmentPoolDepsForTests(fake.deps);
const control = await import("../server/alignment-host-control.ts");
const { RESTART_TARGETS, resetHostRestartsForTests, setHostRestartTimingForTests } = control;
const { setHostDisabled } = await import("../server/activity-pause.ts");
const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { createAlignment, alignmentJob, processAlignments, stopAlignments, resetAlignmentRunnerForTests, alignmentSchedulerForTests } =
  await import("../server/alignment.ts");
const { setBookJobClockForTests } = await import("../server/alignment-book-job.ts");
const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });

let now = 1_800_000_000_000;
setBookJobClockForTests({ now: () => now, sleep: async (ms) => { now += ms; await new Promise((resolve) => setTimeout(resolve, 2)); } });

after(async () => {
  setBookJobClockForTests(null);
  setHostRestartTimingForTests(null);
  stopAlignments();
  await app.close();
  setAlignmentPoolDepsForTests(null);
  await fake.close();
  rmSync(temp, { recursive: true, force: true });
});

const RESTART = RESTART_TARGETS["ctc-worker"];
const restarts = (hostId: string) => fake.hosts[hostId].commands.filter((command) => command.startsWith("systemctl"));

beforeEach(() => {
  for (const host of Object.values(fake.hosts)) {
    Object.assign(host, { down: false, busy: false, stuck: false, activeRequests: 0, slotsHeld: 0, resuming: 0, healthDrops: 0,
      revision: undefined, restartFails: undefined, onServiceCommand: undefined, holdAt: null, commands: [], starts: [], book: [] });
    host.jobs.clear();
    setHostDisabled(host.id, false);
  }
  resetHostRestartsForTests();
  setHostRestartTimingForTests({ pollMs: 1, readyWithinMs: 5_000 });
  resetAlignmentPoolStatusCache();
});

let cookie = "";
async function admin() {
  if (cookie) return cookie;
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-password" } });
  assert.equal(response.statusCode, 200, response.body);
  cookie = response.cookies[0].value;
  return cookie;
}
type Payload = Record<string, unknown>;
const post = async (url: string, payload?: Payload) =>
  app.inject({ method: "POST", url, cookies: { sonder_session: await admin() }, ...(payload === undefined ? {} : { payload }) });
const restart = (hostId: string, payload?: Payload) => post(`/api/activity/services/alignment-host:${hostId}/restart`, payload);
const disable = (hostId: string, disabled: unknown) => post(`/api/activity/services/alignment-host:${hostId}/disable`, { disabled });

async function hostRow(hostId: string) {
  resetAlignmentPoolStatusCache();
  const response = await app.inject({ method: "GET", url: "/api/activity", cookies: { sonder_session: await admin() } });
  assert.equal(response.statusCode, 200, response.body);
  const row = response.json().processes.find((process: { id: string }) => process.id === `alignment-host:${hostId}`);
  assert.ok(row, `the ${hostId} row is listed: ${JSON.stringify(response.json().processes.filter((p: { type: string }) => p.type === "service"))}`);
  return row;
}

/** A whole-book job the fake worker holds, as one the server started there. */
function workerJob(hostId: string, jobId = "held-job") {
  const job = { jobId, request: { tracks: [] }, identity: "{}", step: 2, polls: 0, failed: null, failAt: null, resumed: 0,
    createdAt: 0, updatedAt: 0, stageTimings: {} } as unknown as FakeBookJob;
  fake.hosts[hostId].jobs.set(jobId, job);
}

let n = 0;
db.insert(schema.works).values({ id: "hosts-work", title: "Speaker for the Dead", author: "Card", description: "", genre: "", year: 1986 }).run();
db.insert(schema.ebookEditions).values({ id: "hosts-ebook", workId: "hosts-work", format: "epub", source: ebookPath }).run();
function recording() {
  const i = ++n;
  const audio = join(process.env.MEDIA_ROOT!, `audio-${i}.wav`);
  writeFileSync(audio, `audio ${i}`);
  db.insert(schema.editions).values({ id: `hosts-edition-${i}`, workId: "hosts-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: `hosts-recording-${i}`, editionId: `hosts-edition-${i}` }).run();
  db.insert(schema.tracks).values({ id: `hosts-track-${i}`, recordingId: `hosts-recording-${i}`, title: "Book", index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
  const track = db.select().from(schema.tracks).all().find((row) => row.id === `hosts-track-${i}`)!;
  return { recordingId: `hosts-recording-${i}`, track };
}

const hostIds = () => getAlignmentPoolCoordinator().listHosts().map((host) => host.id);
const leaseHeld = (id: string) => hostIds().some((host) => getAlignmentPoolCoordinator().hasJobLease(host, id));
async function settled(id: string, statuses = ["partial", "ready", "error", "cancelled"]) {
  for (let i = 0; i < 2000; i++) {
    const job = alignmentJob(id);
    if (statuses.includes(job.status) && !leaseHeld(id) && !alignmentSchedulerForTests().running().includes(id)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Alignment did not settle: ${alignmentJob(id).status}`);
}
async function until(condition: () => boolean, label = "condition") {
  for (let i = 0; i < 2000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), `${label} not reached`);
}

test("restart and the switch are for the administrator only, and an unknown host is refused", async () => {
  const made = await post("/api/users", { username: "reader", password: "password1" });
  assert.equal(made.statusCode, 200, made.body);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "reader", password: "password1" } });
  const member = login.cookies[0].value;
  for (const action of ["restart", "disable"]) {
    const url = `/api/activity/services/alignment-host:wsl/${action}`;
    assert.equal((await app.inject({ method: "POST", url, payload: { force: true, disabled: true } })).statusCode, 401, action);
    assert.equal((await app.inject({ method: "POST", url, cookies: { sonder_session: member }, payload: { force: true, disabled: true } })).statusCode, 403, action);
    assert.equal((await post(`/api/activity/services/alignment-host:nowhere/${action}`, { force: true, disabled: true })).statusCode, 404, action);
    assert.equal((await post(`/api/activity/services/torrent-client/${action}`, { force: true })).statusCode, 404, action);
  }
  assert.deepEqual([...restarts("wsl"), ...restarts("lisa")], [], "nothing reached a host");
  assert.equal((await hostRow("wsl")).host.disabled, false, "the member's request changed nothing");
});

test("each host row shows online or offline, its current job and the worker's code version", async () => {
  fake.hosts.wsl.revision = "c901429";
  fake.hosts.wsl.activeRequests = 1;
  fake.hosts.wsl.slotsHeld = 1;
  workerJob("wsl");
  const { recordingId } = recording();
  sqlite.prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES('hosts-running','hosts-ebook',?,?,?)")
    .run(recordingId, JSON.stringify({ id: "hosts-running", status: "processing", progress: 0.4, createdAt: Date.now(), intervals: [],
      pool: { hostId: "wsl", attempt: 1, jobMediaRoot: "", workerUrl: "", triedHosts: ["wsl"], stagedAudio: {} } }), Date.now());
  fake.hosts.lisa.down = true;
  try {
    const wsl = (await hostRow("wsl")).host;
    assert.equal(wsl.online, true);
    assert.equal(wsl.revision, "c901429");
    assert.equal(wsl.device, "cuda");
    assert.equal(wsl.work, "1 window request · 1 whole-book job, encoding");
    assert.deepEqual(wsl.jobs, ["Speaker for the Dead"]);
    assert.equal(wsl.disabled, false);
    const lisa = await hostRow("lisa");
    assert.equal(lisa.health, "down");
    assert.equal(lisa.host.online, false);
    assert.equal(lisa.host.revision, null, "no answer: the version is unknown");
    assert.equal(lisa.host.work, null);

    // A worker from before the field reports no revision: unknown. An idle worker has no current job.
    fake.hosts.lisa.down = false;
    fake.hosts.wsl.revision = undefined;
    fake.hosts.wsl.activeRequests = 0;
    fake.hosts.wsl.slotsHeld = 0;
    fake.hosts.wsl.jobs.clear();
    assert.equal((await hostRow("lisa")).host.online, true);
    const idle = (await hostRow("wsl")).host;
    assert.equal(idle.revision, null);
    assert.equal(idle.work, null);
    // A worker picking up its retained jobs after its own start, and one with a stuck session.
    fake.hosts.wsl.resuming = 1;
    fake.hosts.wsl.stuck = true;
    assert.equal((await hostRow("wsl")).host.work, "resuming whole-book jobs · 1 stuck");
  } finally {
    sqlite.prepare("DELETE FROM alignment_jobs WHERE id='hosts-running'").run();
  }
});

test("restart is refused while the host runs anything or cannot be read, nothing is sent, and the row shows why", async () => {
  const refused = async (setup: () => void, code: string, reason: RegExp, undo: () => void) => {
    setup();
    try {
      const response = await restart("wsl", {});
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().code, code);
      assert.match(response.json().error, reason);
      assert.deepEqual(restarts("wsl"), [], `nothing was sent for ${reason}`);
      const last = (await hostRow("wsl")).host.lastRestart;
      assert.equal(last.ok, false);
      assert.equal(last.forced, false);
      assert.match(last.message, /^Restart refused\. /);
    } finally {
      undo();
    }
  };
  await refused(() => { fake.hosts.wsl.activeRequests = 2; }, "host_busy", /running 2 window requests/, () => { fake.hosts.wsl.activeRequests = 0; });
  await refused(() => workerJob("wsl"), "host_busy", /running 1 whole-book job/, () => fake.hosts.wsl.jobs.clear());
  await refused(() => { fake.hosts.wsl.slotsHeld = 1; }, "host_busy", /running an encode/, () => { fake.hosts.wsl.slotsHeld = 0; });
  await refused(() => { fake.hosts.wsl.resuming = 1; }, "host_busy", /a resume of its whole-book jobs/, () => { fake.hosts.wsl.resuming = 0; });
  const { recordingId } = recording();
  await refused(() => assert.ok(getAlignmentPoolCoordinator().tryAcquireCtc("wsl", "holder", recordingId, 1)), "host_busy",
    /1 job leased by Sonder/, () => getAlignmentPoolCoordinator().release("wsl", "holder", recordingId));
  await refused(() => { fake.hosts.wsl.down = true; }, "host_unreadable", /status cannot be read/, () => { fake.hosts.wsl.down = false; });
  // An empty body (an older client, or a plain POST) is an unforced restart: also refused.
  workerJob("wsl");
  assert.equal((await restart("wsl")).statusCode, 409);
  assert.deepEqual(restarts("wsl"), []);
});

test("a forced restart sends the one allowlisted command, waits for /health ready again, and the row shows the result", async () => {
  fake.hosts.wsl.activeRequests = 1;
  workerJob("wsl");
  fake.hosts.wsl.revision = "old";
  let healthAtRestart = -1;
  fake.hosts.wsl.onServiceCommand = () => {
    // The worker stops and starts: its /health drops the next requests, then answers with the new code.
    healthAtRestart = fake.hosts.wsl.healthRequests;
    fake.hosts.wsl.healthDrops = 3;
    fake.hosts.wsl.activeRequests = 0;
    fake.hosts.wsl.revision = "new";
  };
  const response = await restart("wsl", { force: true });
  assert.equal(response.statusCode, 200, response.body);
  const reply = response.json();
  assert.equal(reply.ok, true);
  assert.equal(reply.forced, true);
  assert.equal(reply.revision, "new");
  assert.match(reply.message, /^Restarted and ready again after \d+ s\.$/);
  assert.deepEqual(restarts("wsl"), [RESTART], "exactly the allowlisted command, nothing else");
  assert.equal(RESTART, "systemctl --user restart sonder-ctc-worker.service");
  assert.deepEqual(restarts("lisa"), []);
  assert.equal(fake.hosts.wsl.healthDrops, 0, "it waited through the dropped answers");
  assert.ok(fake.hosts.wsl.healthRequests >= healthAtRestart + 4, "and read /health until it answered ready");
  const row = (await hostRow("wsl")).host;
  assert.equal(row.restarting, false);
  assert.equal(row.lastRestart.ok, true);
  assert.equal(row.lastRestart.forced, true);
  assert.equal(row.lastRestart.message, reply.message);
  assert.equal(row.revision, "new");

  // An idle host restarts without forcing.
  fake.hosts.lisa.revision = "abc";
  const idle = await restart("lisa", {});
  assert.equal(idle.statusCode, 200, idle.body);
  assert.deepEqual(restarts("lisa"), [RESTART]);
  // So does a host that cannot be read, when forced: the command goes out without the check.
  fake.hosts.wsl.down = true;
  fake.hosts.wsl.onServiceCommand = () => { fake.hosts.wsl.down = false; };
  const unreadable = await restart("wsl", { force: true });
  assert.equal(unreadable.statusCode, 200, unreadable.body);
  assert.equal(restarts("wsl").length, 2);
});

test("a restart whose command fails, or whose worker is not ready within the bound, reports why on the row", async () => {
  fake.hosts.wsl.restartFails = "Failed to restart sonder-ctc-worker.service: Unit not found.";
  const failed = await restart("wsl", {});
  assert.equal(failed.statusCode, 502, failed.body);
  assert.equal(failed.json().code, "restart_failed");
  assert.match(failed.json().error, /The restart command failed: .*Unit not found/);
  assert.match((await hostRow("wsl")).host.lastRestart.message, /Unit not found/);

  fake.hosts.wsl.restartFails = undefined;
  setHostRestartTimingForTests({ readyWithinMs: 50 });
  fake.hosts.wsl.onServiceCommand = () => { fake.hosts.wsl.healthDrops = Number.MAX_SAFE_INTEGER; };
  const late = await restart("wsl", {});
  assert.equal(late.statusCode, 504, late.body);
  assert.equal(late.json().code, "restart_not_ready");
  assert.match(late.json().error, /^Restarted, but the worker did not answer ready within 0 s: /);
  const row = await hostRow("wsl");
  assert.equal(row.host.lastRestart.ok, false);
  assert.equal(row.host.online, false);
});

test("a second restart of a host while one runs is refused, and the row says it is restarting", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  fake.hosts.wsl.onServiceCommand = () => held;
  const first = restart("wsl", {});
  await until(() => restarts("wsl").length === 1, "the restart command reached the host");
  const second = await restart("wsl", { force: true });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().code, "host_restarting");
  assert.equal((await hostRow("wsl")).host.restarting, true);
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal(restarts("wsl").length, 1, "the refused restart sent nothing");
  assert.equal((await hostRow("wsl")).host.restarting, false);
});

test("the disable switch: stored with the pause switches, labelled on the row, and it survives a server restart", async () => {
  assert.equal((await disable("wsl", "yes")).statusCode, 400);
  const response = await disable("wsl", true);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, id: "alignment-host:wsl", disabled: true });
  assert.equal((sqlite.prepare("SELECT value FROM settings WHERE key='activityHostDisabled:wsl'").get() as { value: string }).value, "1");
  const row = await hostRow("wsl");
  assert.equal(row.host.disabled, true);
  assert.equal((await hostRow("lisa")).host.disabled, false);
  // A disabled host that is offline is "disabled by you", not down: it does not light the Settings indicator.
  fake.hosts.wsl.down = true;
  const offline = await hostRow("wsl");
  assert.equal(offline.health, "unknown");
  assert.equal(offline.host.online, false);
  fake.hosts.wsl.down = false;

  // A new server process on the same database reads the switch.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "const { isHostDisabled } = await import('./server/activity-pause.ts'); console.log(JSON.stringify([isHostDisabled('wsl'), isHostDisabled('lisa')]));"],
  { cwd: root, encoding: "utf8", env: { ...process.env } });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout.trim().split("\n").at(-1)!), [true, false]);

  assert.equal((await disable("wsl", false)).statusCode, 200);
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='activityHostDisabled:wsl'").get(), undefined);
  assert.equal((await hostRow("wsl")).host.disabled, false);
});

test("a disabled host gets no new jobs, probes or whole-book jobs; they go to the other host, or wait", async () => {
  const { recordingId, track } = recording();
  let leases = 0;
  const lease = (request: Partial<Parameters<typeof acquireWorkerLease>[0]> = {}) => acquireWorkerLease({
    id: `disabled-${++leases}`, recordingId, mode: "anchored", tracks: [track], localAudio: (row) => row.source, kind: "job", ...request,
  });
  const hostOf = async (request: Partial<Parameters<typeof acquireWorkerLease>[0]> = {}) => {
    const held = await lease(request);
    const hostId = held.hostId;
    await held.release("finished");
    return hostId;
  };
  assert.equal(await hostOf({ book: true }), "wsl", "enabled, WSL takes the book");
  assert.equal((await disable("wsl", true)).statusCode, 200);
  const healthBefore = fake.hosts.wsl.healthRequests;
  const stagedBefore = fake.stagedFolders("wsl").length;
  const diagnostics: { poolErrors?: Record<string, string> } = {};
  assert.equal(await hostOf({ diagnostics }), "lisa", "window job");
  assert.match(diagnostics.poolErrors?.wsl ?? "", /^disabled: /);
  assert.equal(await hostOf({ kind: "probe" }), "lisa", "probe");
  assert.equal(await hostOf({ book: true }), "lisa", "whole-book job: the CPU host is the fallback when the GPU host is disabled");
  const job = await lease({});
  assert.deepEqual(job.triedHosts, ["lisa"], "a disabled host is not counted as tried");
  await job.release("finished");
  assert.equal(fake.hosts.wsl.healthRequests, healthBefore, "a disabled host is not even asked");
  assert.equal(fake.stagedFolders("wsl").length, stagedBefore, "nothing staged there");

  // With every host disabled the work waits (busy), it does not fail.
  assert.equal((await disable("lisa", true)).statusCode, 200);
  await assert.rejects(() => lease({ book: true }), PoolBusyError);
  await assert.rejects(() => lease({ kind: "probe" }), PoolBusyError);
  assert.equal((await disable("lisa", false)).statusCode, 200);
  assert.equal((await disable("wsl", false)).statusCode, 200);
  assert.equal(await hostOf({ book: true }), "wsl", "enabled again, WSL takes the book again");
});

test("with WSL disabled a whole-book alignment runs to its map on lisa", async () => {
  assert.equal((await disable("wsl", true)).statusCode, 200);
  resetAlignmentRunnerForTests();
  const created = await createAlignment("hosts-ebook", recording().recordingId, undefined, "anchored");
  await processAlignments();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "lisa");
  assert.equal(fake.hosts.lisa.starts.length, 1);
  assert.equal(fake.hosts.wsl.starts.length, 0);
  assert.deepEqual(fake.hosts.wsl.book, [], "WSL got no whole-book request");
});

test("work already running on a host finishes there after the host is disabled, also across a server restart", async () => {
  resetAlignmentRunnerForTests();
  fake.hosts.wsl.holdAt = "encoding";
  // Creating the job starts it; it waits on WSL at encoding.
  const created = await createAlignment("hosts-ebook", recording().recordingId, undefined, "anchored");
  await until(() => alignmentJob(created.id).bookJob?.state === "encoding", "the job runs on WSL");
  assert.equal((await disable("wsl", true)).statusCode, 200);
  // The server restarts while the worker's job runs: the job goes back to the host it was started on.
  stopAlignments();
  await alignmentSchedulerForTests().settled();
  fake.hosts.wsl.holdAt = null;
  resetAlignmentRunnerForTests({ restart: true });
  await processAlignments();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.equal(job.pool?.hostId, "wsl");
  assert.equal(fake.hosts.wsl.starts.length, 1, "started once, on WSL, before it was disabled");
  assert.equal(fake.hosts.lisa.starts.length, 0, "and not moved to lisa");
});
