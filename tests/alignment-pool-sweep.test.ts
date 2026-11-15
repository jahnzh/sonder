// Removing staged pool audio (#421) through an in-process fake of the pool hosts (tests/fake-pool-host.ts): no SSH,
// no network. The sweep removes a folder only from the server's own records, under the recording's lease, and retires
// the folder's name before it sends the removal, so a removal that outlives its deadline cannot reach a later run.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerFixture } from "./reader-fixture.ts";
import { alignAnswer, fakePoolHosts, type FakeHostState, type FakePool } from "./fake-pool-host.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-pool-sweep-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.ALIGNMENT_WORKER_TOKEN = "test-token";
process.env.ALIGNMENT_POOL_ENABLED = "1";
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
const ebookPath = join(process.env.MEDIA_ROOT, "book.epub");
writeFileSync(ebookPath, await readerFixture({ bodies: ["<p>First sentence. Another sentence.</p>", "<p>Middle sentence. Last sentence.</p>"] }));

const { db, sqlite } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { extractBook } = await import("../server/reader.ts");
const { createAlignment, alignmentJob, putAlignmentJob, processAlignments, stopAlignments, resetAlignmentRunnerForTests,
  alignmentSchedulerForTests } = await import("../server/alignment.ts");
const transition = await import("../server/alignment-transitions.ts");
const pool = await import("../server/alignment-pool.ts");
const sweep = await import("../server/alignment-pool-sweep.ts");
const { getAlignmentPoolCoordinator, resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests, acquireWorkerLease } = pool;
const originalFetch = globalThis.fetch;

db.insert(schema.works).values({ id: "sweep-work", title: "Book", author: "Author", description: "", genre: "", year: 2026 }).run();
db.insert(schema.ebookEditions).values({ id: "sweep-ebook", workId: "sweep-work", format: "epub", source: ebookPath }).run();

let fake: FakePool;
let recordings = 0;

function install(answer?: Parameters<typeof fakePoolHosts>[2]) {
  fake = fakePoolHosts(join(temp, `hosts-${++recordings}`), undefined, answer);
  resetAlignmentPoolCoordinator(Object.values(fake.hosts).map((host, index) => ({
    id: host.id, sshTarget: host.sshTarget, maxConcurrent: 1, remoteWorkRoot: host.root, workerUrl: host.workerUrl,
    device: host.device, precision: host.precision, rank: index + 1,
  })));
  setAlignmentPoolDepsForTests(fake.deps);
  globalThis.fetch = fake.fetch;
}

const removals = (host: FakeHostState) => host.commands.filter((command) => /\brm\b/.test(command));
const isListing = (command: string) => command.includes("du -sk");
const isRemoval = (command: string) => /\brm -rf /.test(command);
const folderOf = (host: FakeHostState, name: string) => join(host.root, "alignment", "pool-jobs", name);

function recording() {
  const n = ++recordings;
  const audio = join(process.env.MEDIA_ROOT!, `audio-${n}.wav`);
  writeFileSync(audio, `audio ${n} `.repeat(4000));
  db.insert(schema.editions).values({ id: `sweep-edition-${n}`, workId: "sweep-work", cover: "", narrator: "", rating: 0, sourceLabel: "", language: "en" }).run();
  db.insert(schema.recordings).values({ id: `sweep-recording-${n}`, editionId: `sweep-edition-${n}` }).run();
  db.insert(schema.tracks).values({ id: `sweep-track-${n}`, recordingId: `sweep-recording-${n}`, title: "Book", index: 0, duration: 400, chapters: [], source: audio, sourceType: "local" }).run();
  return { recordingId: `sweep-recording-${n}`, trackId: `sweep-track-${n}` };
}

async function pairings(trackId: string) {
  const book = await extractBook("sweep-ebook");
  return book.sections.map((section, i) => ({ section: section.index, trackId, start: 10 + i * 100, duration: 80 }));
}

/** A chapter job over both sections of the book: two /align requests. */
async function chapterJob() {
  const { recordingId, trackId } = recording();
  return createAlignment("sweep-ebook", recordingId, await pairings(trackId), "chapters");
}

const hostIds = () => getAlignmentPoolCoordinator().listHosts().map((host) => host.id);
const leaseHeld = (id: string) => hostIds().some((host) => getAlignmentPoolCoordinator().hasJobLease(host, id));

async function settled(id: string, statuses = ["partial", "ready", "error", "cancelled"]) {
  for (let i = 0; i < 300; i++) {
    const job = alignmentJob(id);
    if (statuses.includes(job.status) && !leaseHeld(id) && !alignmentSchedulerForTests().running().includes(id)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Alignment did not settle: ${alignmentJob(id).status}`);
}

/** A finished job staged on WSL. */
async function finishedJob() {
  const created = await chapterJob();
  const job = await settled(created.id);
  assert.equal(job.status, "partial", job.error ?? undefined);
  assert.deepEqual(fake.stagedFolders("wsl"), [job.id]);
  return job;
}

/** A job a test left queued must not run in a later test. */
function endQueued(id: string) {
  sqlite.prepare("UPDATE alignment_jobs SET claim_owner=NULL WHERE id=?").run(id);
  putAlignmentJob({ ...alignmentJob(id), status: "cancelled" });
}

const entry = (listing: Awaited<ReturnType<typeof sweep.listPoolStaging>>, hostId: string, name: string) => {
  const found = listing.hosts.find((host) => host.hostId === hostId)?.folders.find((folder) => folder.name === name);
  assert.ok(found, `${hostId}/${name} is listed`);
  return found;
};
const result = (run: Awaited<ReturnType<typeof sweep.removePoolStaging>>, hostId: string, name: string) => {
  const found = run.hosts.find((host) => host.hostId === hostId)?.folders.find((folder) => folder.name === name);
  assert.ok(found, `${hostId}/${name} is in the run`);
  return found;
};

beforeEach(() => {
  resetAlignmentRunnerForTests();
  sweep.setPoolSweepTimeoutsForTests(null);
  install();
});

after(() => {
  globalThis.fetch = originalFetch;
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  stopAlignments();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test("the host listing parses the type, size in KiB and name of each entry, as the listing command prints them", () => {
  // Printed by the listing command on a sample pool-jobs folder (a job folder, a symlink, a file, a name with a
  // space, a hidden folder).
  const sample = "d\t304\tjob-a\nf\t0\tlink\nf\t4\tloose-file\nd\t4\twe ird\nd\t4\t.hidden\nd\t-\tunreadable\n";
  assert.deepEqual(sweep.parseStagingListing(sample), [
    { name: "job-a", directory: true, sizeKiB: 304 },
    { name: "link", directory: false, sizeKiB: 0 },
    { name: "loose-file", directory: false, sizeKiB: 4 },
    { name: "we ird", directory: true, sizeKiB: 4 },
    { name: ".hidden", directory: true, sizeKiB: 4 },
    { name: "unreadable", directory: true, sizeKiB: null },
  ]);
  assert.deepEqual(sweep.parseStagingListing(""), []);

  // The whole output starts with the real paths of the root and its pool-jobs folder. Printed by the listing command
  // for a root reached through a symlink (`media-link` -> `real-media`) and for a root with no pool-jobs folder yet;
  // only the scratch directory prefix is shortened to /srv.
  const throughLink = "R\t/srv/real-media\nP\t/srv/real-media/alignment/pool-jobs\nd\t304\tjob-a\nf\t0\tlink\nf\t4\tloose-file\n";
  assert.deepEqual(sweep.parseHostListing(throughLink), {
    realRoot: "/srv/real-media", realPoolJobs: "/srv/real-media/alignment/pool-jobs",
    entries: [
      { name: "job-a", directory: true, sizeKiB: 304 },
      { name: "link", directory: false, sizeKiB: 0 },
      { name: "loose-file", directory: false, sizeKiB: 4 },
    ],
  });
  assert.deepEqual(sweep.parseHostListing("R\t/srv/fresh\nP\t/srv/fresh/alignment/pool-jobs\n"),
    { realRoot: "/srv/fresh", realPoolJobs: "/srv/fresh/alignment/pool-jobs", entries: [] });
  // A root of / prints //alignment/pool-jobs.
  assert.equal(sweep.parseHostListing("R\t/\nP\t//alignment/pool-jobs\n").realPoolJobs, "/alignment/pool-jobs");
  // Without the real paths (an older listing, a path with a newline) the host is not listed.
  assert.throws(() => sweep.parseHostListing("d\t304\tjob-a\n"), /real path/);
  assert.throws(() => sweep.parseHostListing("R\t/srv/a\nb\nP\t/srv/a/alignment/pool-jobs\n"), /real path/);
  assert.throws(() => sweep.parseHostListing("R\trelative\nP\t/srv/a/alignment/pool-jobs\n"), /not absolute/);
});

test("the listing command reports real paths: a root through a symlink, and a pool-jobs folder not made yet", async () => {
  const base = join(temp, "real-paths");
  mkdirSync(join(base, "real-media", "alignment", "pool-jobs", "job-a"), { recursive: true });
  mkdirSync(join(base, "fresh"), { recursive: true });
  symlinkSync(join(base, "real-media"), join(base, "media-link"));
  const { execFileSync } = await import("node:child_process");
  const run = (root: string) => sweep.parseHostListing(execFileSync("sh", ["-c",
    sweep.listingCommand(root, join(root, "alignment", "pool-jobs"))], { encoding: "utf8" }));
  const linked = run(join(base, "media-link"));
  const real = realpathSync(join(base, "real-media"));
  assert.equal(linked.realRoot, real);
  assert.equal(linked.realPoolJobs, join(real, "alignment", "pool-jobs"));
  assert.deepEqual(linked.entries.map((item) => item.name), ["job-a"]);
  const fresh = run(join(base, "fresh"));
  assert.equal(fresh.realPoolJobs, join(realpathSync(join(base, "fresh")), "alignment", "pool-jobs"));
  assert.deepEqual(fresh.entries, []);
});

test("the dry run lists every folder per host with its size and what a run would do, and removes nothing", async () => {
  const finished = await finishedJob();

  // A paused job keeps its staging for its next run.
  let paused!: Awaited<ReturnType<typeof chapterJob>>;
  fake.hosts.wsl.onRequest = (n) => { if (n === 3) putAlignmentJob({ ...alignmentJob(paused.id), status: "paused" }); };
  paused = await chapterJob();
  assert.equal((await settled(paused.id, ["paused"])).status, "paused");
  fake.hosts.wsl.onRequest = undefined;

  // A job that was deleted with its recording: its row is gone, the record of where it staged is kept.
  const gone = await settled((await chapterJob()).id);
  assert.equal(gone.pool?.hostId, "wsl");
  transition.removeAlignmentJobsForRecording(gone.recordingId);

  // A probe that is running holds its own folder.
  const probeRecording = recording();
  const [probeTrack] = db.select().from(schema.tracks).all().filter((track) => track.recordingId === probeRecording.recordingId);
  const probe = await acquireWorkerLease({ id: "ctc-probe-live", recordingId: probeRecording.recordingId, mode: "anchored",
    tracks: [probeTrack], localAudio: (row) => row.source, kind: "probe" });

  // Folders the server has no record of: one from before leases, a probe that ended in an earlier process, a file.
  const jobs = join(fake.hosts.wsl.root, "alignment", "pool-jobs");
  mkdirSync(join(jobs, "staged-before-leases", "tracks"), { recursive: true });
  writeFileSync(join(jobs, "staged-before-leases", "tracks", "t1"), "x".repeat(10_000));
  mkdirSync(join(jobs, "ctc-probe-ended"), { recursive: true });
  writeFileSync(join(jobs, "stray-file"), "x");

  try {
    // A host that cannot be listed refuses the whole run: the dry run says so for every host and nothing is removable.
    fake.hosts.lisa.down = true;
    const refusedListing = await sweep.listPoolStaging();
    const lisa = refusedListing.hosts.find((host) => host.hostId === "lisa")!;
    assert.match(lisa.error ?? "", /health|ECONNREFUSED|fetch failed/);
    assert.deepEqual(lisa.folders, []);
    for (const host of refusedListing.hosts) assert.match(host.refused ?? "", /lisa could not be listed/, host.hostId);
    assert.equal(entry(refusedListing, "wsl", finished.id).action, "keep");
    assert.match(entry(refusedListing, "wsl", finished.id).reason, /refused/);
    assert.equal(refusedListing.hosts.find((host) => host.hostId === "wsl")!.removableKiB, 0);
    // Also for a run of WSL alone.
    const onlyWsl = await sweep.listPoolStaging({ host: "wsl" });
    assert.match(onlyWsl.hosts[0].refused ?? "", /lisa could not be listed/);
    const refusedRun = await sweep.removePoolStaging({ host: "wsl" });
    assert.match(refusedRun.hosts[0].refused ?? "", /lisa could not be listed/);
    assert.equal(result(refusedRun, "wsl", finished.id).result, "kept");
    assert.deepEqual(removals(fake.hosts.wsl), [], "a refused run sends no removal");
    fake.hosts.lisa.down = false;

    const listing = await sweep.listPoolStaging();
    const wsl = listing.hosts.find((host) => host.hostId === "wsl")!;
    assert.equal(wsl.root, fake.hosts.wsl.root);
    assert.equal(wsl.realRoot, realpathSync(fake.hosts.wsl.root));
    assert.equal(wsl.realPoolJobs, realpathSync(jobs));
    assert.equal(wsl.error, null);
    assert.equal(wsl.refused, null);
    assert.deepEqual(wsl.folders.map((folder) => folder.name).sort(),
      [finished.id, paused.id, gone.id, "ctc-probe-live", "staged-before-leases", "ctc-probe-ended", "stray-file"].sort());

    const done = entry(listing, "wsl", finished.id);
    assert.equal(done.action, "remove");
    assert.equal(done.jobId, finished.id);
    assert.equal(done.status, "partial");
    assert.equal(done.path, folderOf(fake.hosts.wsl, finished.id));
    assert.ok(done.sizeKiB !== null && done.sizeKiB > 0, "the size is listed");
    assert.equal(entry(listing, "wsl", gone.id).action, "remove");
    assert.equal(entry(listing, "wsl", gone.id).status, null);
    assert.equal(entry(listing, "wsl", paused.id).action, "keep");
    assert.equal(entry(listing, "wsl", "ctc-probe-live").action, "keep");
    for (const name of ["staged-before-leases", "ctc-probe-ended", "stray-file"])
      assert.equal(entry(listing, "wsl", name).action, "unknown", name);
    assert.ok(entry(listing, "wsl", "staged-before-leases").sizeKiB! >= 8);
    assert.equal(wsl.removableKiB, done.sizeKiB! + entry(listing, "wsl", gone.id).sizeKiB!);
    assert.equal(listing.hosts.find((host) => host.hostId === "lisa")!.error, null);

    assert.deepEqual(removals(fake.hosts.wsl), [], "the dry run sends no removal");
    assert.ok(existsSync(folderOf(fake.hosts.wsl, finished.id)));

    // The real run removes the finished and the deleted job's folders; the rest stays.
    const run = await sweep.removePoolStaging();
    assert.equal(result(run, "wsl", finished.id).result, "removed");
    assert.equal(result(run, "wsl", gone.id).result, "removed");
    assert.deepEqual(fake.stagedFolders("wsl"),
      [paused.id, "ctc-probe-live", "staged-before-leases", "ctc-probe-ended", "stray-file"].sort());
    for (const name of [paused.id, "ctc-probe-live", "staged-before-leases", "ctc-probe-ended", "stray-file"])
      assert.notEqual(result(run, "wsl", name).result, "removed", name);
    assert.equal(removals(fake.hosts.wsl).length, 2);
    // Another dry run no longer lists them.
    const again = await sweep.listPoolStaging();
    assert.ok(!again.hosts[0].folders.some((folder) => folder.name === finished.id || folder.name === gone.id));
  } finally {
    await probe.release("finished");
    endQueued(paused.id);
  }
});

test("a job resumed, prepared again or rebuilt between the listing and the removal keeps its audio", async () => {
  const cases: [string, (job: ReturnType<typeof alignmentJob>) => void | Promise<void>][] = [
    ["resumed", (job) => { transition.resume(job); }],
    ["prepared again", async (job) => {
      await createAlignment("sweep-ebook", job.recordingId, job.pairings, "chapters");
    }],
    ["rebuilt", (job) => { transition.queueRebuild(job, { ...job, generation: "rebuild", progress: 0 }); }],
  ];
  for (const [label, change] of cases) {
    install();
    // Two finished jobs on WSL; the run removes them in name order and awaits each removal.
    const jobs = [await settled((await chapterJob()).id), await settled((await chapterJob()).id)]
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(fake.stagedFolders("wsl"), jobs.map((job) => job.id), label);
    const [first, second] = jobs;
    stopAlignments();
    let changed = false;
    // While the first folder's removal runs, the second job becomes active again.
    fake.hosts.wsl.afterCommand = async (command) => {
      if (!isRemoval(command) || changed) return;
      changed = true;
      await change(alignmentJob(second.id));
    };
    try {
      const run = await sweep.removePoolStaging();
      assert.ok(changed, label);
      assert.equal(result(run, "wsl", first.id).result, "removed", label);
      assert.equal(result(run, "wsl", second.id).action, "remove", `${label}: the listing had marked it for removal`);
      assert.notEqual(alignmentJob(second.id).status, "partial", `${label}: the job is active again`);
      assert.equal(result(run, "wsl", second.id).result, "kept", label);
      assert.match(result(run, "wsl", second.id).detail ?? "", /Checked again under the lease/, label);
      assert.equal(removals(fake.hosts.wsl).length, 1, `${label}: one removal sent`);
      assert.deepEqual(fake.stagedFolders("wsl"), [second.id], label);
      assert.equal(sweep.stagingNameRetired(second.id), false, `${label}: the name stays usable`);
    } finally {
      endQueued(second.id);
      resetAlignmentRunnerForTests();
    }
  }
});

test("a finished job's folder is kept while its recording is leased or a run of the job is in flight", async () => {
  const job = await finishedJob();
  const [track] = db.select().from(schema.tracks).all().filter((row) => row.recordingId === job.recordingId);
  const wslHost = (listing: Awaited<ReturnType<typeof sweep.listPoolStaging>>) => listing.hosts.find((host) => host.hostId === "wsl")!;
  // A probe of the same recording holds the recording's lease (on lisa, so the slot is not the reason).
  fake.hosts.wsl.busy = true;
  const probe = await acquireWorkerLease({ id: "ctc-probe-same-recording", recordingId: job.recordingId, mode: "anchored",
    tracks: [track], localAudio: (row) => row.source, kind: "probe" });
  fake.hosts.wsl.busy = false;
  try {
    assert.equal(probe.hostId, "lisa");
    // The dry run says what the run does: kept, and not counted as removable.
    const listing = await sweep.listPoolStaging();
    assert.equal(entry(listing, "wsl", job.id).action, "keep");
    assert.match(entry(listing, "wsl", job.id).reason, /recording is leased/);
    assert.equal(wslHost(listing).removableKiB, 0);
    const run = await sweep.removePoolStaging({ host: "wsl" });
    assert.equal(result(run, "wsl", job.id).result, "kept");
    assert.match(result(run, "wsl", job.id).reason, /lease/);
    assert.deepEqual(removals(fake.hosts.wsl), []);
  } finally {
    await probe.release("finished");
  }

  // A run of the job (cancelled, still unwinding) is in flight between its leases.
  sweep.setPoolSweepRunCheckForTests((id) => id === job.id);
  try {
    const listing = await sweep.listPoolStaging();
    assert.equal(entry(listing, "wsl", job.id).action, "keep");
    assert.match(entry(listing, "wsl", job.id).reason, /run of its job is in flight/);
    assert.equal(wslHost(listing).removableKiB, 0);
    const run = await sweep.removePoolStaging({ host: "wsl" });
    assert.equal(result(run, "wsl", job.id).result, "kept");
    assert.match(result(run, "wsl", job.id).reason, /run/);
    assert.deepEqual(removals(fake.hosts.wsl), []);
  } finally {
    sweep.setPoolSweepRunCheckForTests(null);
  }
  assert.deepEqual(fake.stagedFolders("wsl"), [job.id]);
  assert.equal(sweep.stagingNameRetired(job.id), false);
  assert.equal(entry(await sweep.listPoolStaging(), "wsl", job.id).action, "remove", "with neither, the dry run says remove");
});

test("a lease or a run that appears after the listing, while an earlier folder's removal runs, keeps the folder", async () => {
  for (const label of ["a probe leases the recording", "a run of the job is in flight"]) {
    install();
    const jobs = [await settled((await chapterJob()).id), await settled((await chapterJob()).id)]
      .sort((a, b) => a.id.localeCompare(b.id));
    const [first, second] = jobs;
    const [track] = db.select().from(schema.tracks).all().filter((row) => row.recordingId === second.recordingId);
    let probe: Awaited<ReturnType<typeof acquireWorkerLease>> | null = null;
    let changed = false;
    fake.hosts.wsl.afterCommand = async (command) => {
      if (!isRemoval(command) || changed) return;
      changed = true;
      if (label.startsWith("a probe")) {
        fake.hosts.wsl.busy = true;
        probe = await acquireWorkerLease({ id: "ctc-probe-late", recordingId: second.recordingId, mode: "anchored",
          tracks: [track], localAudio: (row) => row.source, kind: "probe" });
        fake.hosts.wsl.busy = false;
      } else sweep.setPoolSweepRunCheckForTests((id) => id === second.id);
    };
    try {
      const run = await sweep.removePoolStaging({ host: "wsl" });
      assert.ok(changed, label);
      assert.equal(result(run, "wsl", first.id).result, "removed", label);
      assert.equal(result(run, "wsl", second.id).action, "remove", `${label}: the listing had marked it for removal`);
      assert.equal(result(run, "wsl", second.id).result, "kept", label);
      assert.match(result(run, "wsl", second.id).detail ?? "", label.startsWith("a probe") ? /leased/ : /run of its job/, label);
      assert.equal(removals(fake.hosts.wsl).length, 1, label);
      assert.deepEqual(fake.stagedFolders("wsl"), [second.id], label);
      assert.equal(sweep.stagingNameRetired(second.id), false, label);
    } finally {
      fake.hosts.wsl.afterCommand = undefined;
      sweep.setPoolSweepRunCheckForTests(null);
      await (probe as Awaited<ReturnType<typeof acquireWorkerLease>> | null)?.release("finished");
    }
  }
});

test("staging never reuses a retired name: the next run of the job stages under a new folder", async () => {
  const job = await finishedJob();
  const first = await sweep.removePoolStaging();
  assert.equal(result(first, "wsl", job.id).result, "removed");
  assert.equal(sweep.stagingNameRetired(job.id), true);
  assert.deepEqual(fake.stagedFolders("wsl"), []);

  transition.resume(alignmentJob(job.id));
  await processAlignments();
  const resumed = await settled(job.id);
  assert.equal(resumed.status, "partial", resumed.error ?? undefined);
  assert.deepEqual(fake.stagedFolders("wsl"), [`${job.id}.r1`]);
  assert.equal(resumed.pool?.jobMediaRoot, folderOf(fake.hosts.wsl, `${job.id}.r1`));
  // The worker writes its output inside the new folder.
  assert.ok(existsSync(join(folderOf(fake.hosts.wsl, `${job.id}.r1`), "alignment", job.id)));

  const second = await sweep.removePoolStaging();
  assert.equal(result(second, "wsl", `${job.id}.r1`).result, "removed");
  transition.resume(alignmentJob(job.id));
  await processAlignments();
  assert.equal((await settled(job.id)).status, "partial");
  assert.deepEqual(fake.stagedFolders("wsl"), [`${job.id}.r2`]);
});

test("a removal that outlives its deadline cannot reach the folder a later run of the same job stages and reads", async () => {
  let lateRemoval: Promise<void> | null = null;
  let releaseRemoval!: () => void;
  const held = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  // The resumed run's first request lets the late removal finish before the worker reads the staged audio.
  install(async (host, path, body) => {
    if (lateRemoval && host.id === "wsl") {
      releaseRemoval();
      await lateRemoval;
    }
    return alignAnswer(host, path, body);
  });
  const job = await finishedJob();
  let removalDone!: () => void;
  // The removal reaches the host but waits there (a slow disk); the server's deadline passes first.
  fake.hosts.wsl.holdCommand = async (command) => {
    if (!isRemoval(command)) return;
    lateRemoval = new Promise<void>((resolve) => { removalDone = resolve; });
    await held;
  };
  fake.hosts.wsl.afterCommand = (command) => { if (isRemoval(command)) removalDone(); };
  sweep.setPoolSweepTimeoutsForTests({ removeMs: 50 });

  const run = await sweep.removePoolStaging();
  assert.equal(result(run, "wsl", job.id).result, "failed");
  assert.equal(sweep.stagingNameRetired(job.id), true, "the name was retired before the removal was sent");
  assert.ok(existsSync(folderOf(fake.hosts.wsl, job.id)), "the removal has not run yet");
  // The sweep has let go of the recording: the job can run again.
  assert.equal(getAlignmentPoolCoordinator().recordingHeld(job.recordingId), false);

  transition.resume(alignmentJob(job.id));
  // Every section asks the worker again: the server's own cache of finished sections goes.
  putAlignmentJob({ ...alignmentJob(job.id), sectionsDone: [], intervals: [] });
  rmSync(join(process.env.MEDIA_ROOT!, "alignment", job.id), { recursive: true, force: true });
  await processAlignments();
  const resumed = await settled(job.id);
  assert.ok(lateRemoval, "the late removal ran during the resumed run");
  assert.equal(resumed.status, "partial", resumed.error ?? undefined);
  assert.equal(resumed.pool?.hostId, "wsl");
  assert.deepEqual(fake.stagedFolders("wsl"), [`${job.id}.r1`], "only the old folder was removed");
  assert.deepEqual(fake.hosts.wsl.requests, ["/align", "/align", "/align", "/align"]);
});

test("after a restart between retiring a name and removing its folder, the name stays retired and a later run removes it", async () => {
  const job = await finishedJob();
  // The server stops after the name is retired and before the removal reaches the host.
  fake.hosts.wsl.holdCommand = (command) => {
    if (isRemoval(command)) throw Object.assign(new Error("Command failed"), { stderr: "ssh: connection closed" });
  };
  const run = await sweep.removePoolStaging();
  assert.equal(result(run, "wsl", job.id).result, "failed");
  fake.hosts.wsl.holdCommand = undefined;

  // A new server process: no leases, a new scheduler owner.
  resetAlignmentPoolCoordinator(getAlignmentPoolCoordinator().listHosts());
  resetAlignmentRunnerForTests({ restart: true });
  assert.equal(sweep.stagingNameRetired(job.id), true);
  transition.resume(alignmentJob(job.id));
  await processAlignments();
  assert.equal((await settled(job.id)).status, "partial");
  assert.deepEqual(fake.stagedFolders("wsl"), [job.id, `${job.id}.r1`].sort());

  const listing = await sweep.listPoolStaging();
  assert.equal(entry(listing, "wsl", job.id).action, "remove");
  assert.match(entry(listing, "wsl", job.id).reason, /retired/);
  // The new folder belongs to the finished job too.
  assert.equal(entry(listing, "wsl", `${job.id}.r1`).action, "remove");
  const second = await sweep.removePoolStaging();
  assert.equal(result(second, "wsl", job.id).result, "removed");
  assert.deepEqual(fake.stagedFolders("wsl"), []);
});

test("only a recorded folder under the worker's pool-jobs is removed: unknown names, files and symlinks never are", async () => {
  const job = await finishedJob();
  const jobs = join(fake.hosts.wsl.root, "alignment", "pool-jobs");
  const outside = join(fake.hosts.wsl.root, "keep-me");
  mkdirSync(outside, { recursive: true });
  // A symlink named after a finished job's folder; a name the staging side never makes.
  const other = await chapterJob();
  await settled(other.id);
  rmSync(join(jobs, other.id), { recursive: true });
  symlinkSync(outside, join(jobs, other.id));
  mkdirSync(join(jobs, "bad name"));
  const listing = await sweep.listPoolStaging();
  assert.equal(entry(listing, "wsl", other.id).action, "unknown");
  assert.equal(entry(listing, "wsl", "bad name").action, "unknown");
  await sweep.removePoolStaging();
  assert.deepEqual(fake.stagedFolders("wsl"), ["bad name", other.id].sort());
  assert.ok(existsSync(outside));
  assert.ok(!existsSync(join(jobs, job.id)));
  assert.equal(removals(fake.hosts.wsl).length, 1);
});

test("a second real run while one is running is refused", async () => {
  await finishedJob();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fake.hosts.wsl.holdCommand = async (command) => { if (isListing(command)) await gate; };
  const first = sweep.removePoolStaging();
  await assert.rejects(sweep.removePoolStaging(), (error: Error & { statusCode?: number }) => error.statusCode === 409);
  release();
  await first;
});

test("a host whose worker media root lies inside a pool-jobs folder is listed with an error and nothing is removed", async () => {
  await finishedJob();
  const nested = join(fake.hosts.wsl.root, "alignment", "pool-jobs", "x");
  const plain = fake.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await plain(input, init);
    if (!String(input).startsWith(fake.hosts.wsl.workerUrl) || !String(input).endsWith("/health")) return response;
    return Response.json({ ...(await response.json()), mediaRoot: nested });
  };
  try {
    const run = await sweep.removePoolStaging({ host: "wsl" });
    assert.match(run.hosts[0].error ?? "", /inside a pool-jobs folder/);
    assert.deepEqual(removals(fake.hosts.wsl), []);
  } finally {
    globalThis.fetch = fake.fetch;
  }
});

test("a removal on one host is refused as a whole while another host's root lies inside a job folder it would remove", async () => {
  // Host A (WSL) has a finished job J. Host B (lisa) is configured with its media root inside J's folder on the same
  // machine, and a probe of another recording has staged there. Removing J would remove B's live audio.
  for (const how of ["through a symlink", "by its path"]) {
    install();
    const job = await finishedJob();
    const jobFolder = folderOf(fake.hosts.wsl, job.id);
    const inside = join(jobFolder, "lisa-media");
    mkdirSync(inside, { recursive: true });
    const link = join(temp, `lisa-link-${++recordings}`);
    if (how === "through a symlink") symlinkSync(inside, link);
    fake.hosts.lisa.root = how === "through a symlink" ? link : inside;

    const other = recording();
    const [track] = db.select().from(schema.tracks).all().filter((row) => row.recordingId === other.recordingId);
    fake.hosts.wsl.busy = true;
    const probe = await acquireWorkerLease({ id: "ctc-probe-nested", recordingId: other.recordingId, mode: "anchored",
      tracks: [track], localAudio: (row) => row.source, kind: "probe" });
    fake.hosts.wsl.busy = false;
    const staged = join(inside, "alignment", "pool-jobs", "ctc-probe-nested", "tracks", encodeURIComponent(track.id));
    try {
      assert.equal(probe.hostId, "lisa", how);
      assert.ok(existsSync(staged), `${how}: the probe's audio is staged inside J`);

      // The run first: it removes nothing on either host, and B's staged audio is still there.
      const run = await sweep.removePoolStaging();
      assert.deepEqual(removals(fake.hosts.wsl), [], `${how}: nothing is sent to A`);
      assert.deepEqual(removals(fake.hosts.lisa), [], `${how}: nothing is sent to B`);
      assert.ok(existsSync(staged), `${how}: B's staged audio is still there`);
      assert.equal(result(run, "wsl", job.id).result, "kept", how);

      const reason = how === "through a symlink"
        ? new RegExp(`lisa's media root ${realpathSync(inside)} lies inside wsl's pool-jobs folder`)
        : /lisa could not be listed \(worker media root lies inside a pool-jobs folder\)/;
      for (const host of run.hosts) assert.match(host.refused ?? "", reason, `${how}: ${host.hostId}`);
      const one = await sweep.removePoolStaging({ host: "wsl" });
      assert.match(one.hosts[0].refused ?? "", reason, how);
      assert.deepEqual(removals(fake.hosts.wsl), [], `${how}: nor for a run of A alone`);

      // The dry run shows the refusal and its reason for every host, and nothing as removable.
      const listing = await sweep.listPoolStaging();
      for (const host of listing.hosts) assert.match(host.refused ?? "", reason, `${how}: ${host.hostId}`);
      if (how === "through a symlink") assert.equal(listing.hosts.find((host) => host.hostId === "lisa")!.error, null,
        "the reported root does not name pool-jobs: only the real path shows the nesting");
      assert.equal(entry(listing, "wsl", job.id).action, "keep", how);
      assert.equal(listing.hosts.find((host) => host.hostId === "wsl")!.removableKiB, 0, how);
      assert.ok(existsSync(staged), how);
      assert.equal(sweep.stagingNameRetired(job.id), false, how);
    } finally {
      await probe.release("finished");
    }
  }
});

test("two hosts with the same real pool-jobs folder are not refused", async () => {
  const job = await finishedJob();
  // lisa reaches the same folder through a symlink: one shared folder, covered by the global retired names.
  const link = join(temp, `same-root-${++recordings}`);
  symlinkSync(fake.hosts.wsl.root, link);
  fake.hosts.lisa.root = link;
  const listing = await sweep.listPoolStaging();
  assert.equal(listing.hosts[0].realPoolJobs, listing.hosts[1].realPoolJobs);
  for (const host of listing.hosts) assert.equal(host.refused, null, host.hostId);
  const run = await sweep.removePoolStaging({ host: "wsl" });
  assert.equal(result(run, "wsl", job.id).result, "removed");
});

test("a deleted job whose id is planned again keeps its old folder until that job is finished", async () => {
  const gone = await finishedJob();
  transition.removeAlignmentJobsForRecording(gone.recordingId);
  assert.equal(entry(await sweep.listPoolStaging(), "wsl", gone.id).action, "remove", "deleted: removable");

  // A row with the same id comes back, active and without a staging record of its own (only the orphan names the folder).
  putAlignmentJob({ ...gone, status: "paused", pool: undefined });
  try {
    const listing = await sweep.listPoolStaging();
    assert.equal(entry(listing, "wsl", gone.id).action, "keep");
    assert.match(entry(listing, "wsl", gone.id).reason, /deleted and planned again \(paused\)/);
    const run = await sweep.removePoolStaging();
    assert.equal(result(run, "wsl", gone.id).result, "kept");
    assert.deepEqual(removals(fake.hosts.wsl), []);
    assert.deepEqual(fake.stagedFolders("wsl"), [gone.id]);

    // Once that job is finished, the folder is removable again from the orphan record.
    putAlignmentJob({ ...alignmentJob(gone.id), status: "cancelled" });
    const again = await sweep.listPoolStaging();
    assert.equal(entry(again, "wsl", gone.id).action, "remove");
    assert.match(entry(again, "wsl", gone.id).reason, /deleted/);
    assert.equal(result(await sweep.removePoolStaging(), "wsl", gone.id).result, "removed");
    assert.deepEqual(fake.stagedFolders("wsl"), []);
  } finally {
    endQueued(gone.id);
  }
});

test("a pool-jobs folder that resolves elsewhere after the listing fails the removal and deletes nothing there", async () => {
  const job = await finishedJob();
  const host = fake.hosts.wsl;
  const poolJobs = join(host.root, "alignment", "pool-jobs");
  const elsewhere = join(host.root, "elsewhere");
  mkdirSync(join(elsewhere, job.id), { recursive: true });
  writeFileSync(join(elsewhere, job.id, "live.wav"), "another tree");
  host.holdCommand = async (command) => {
    if (!isRemoval(command)) return;
    host.holdCommand = undefined;
    renameSync(poolJobs, join(host.root, "alignment", "pool-jobs-checked"));
    symlinkSync(elsewhere, poolJobs);
  };
  try {
    const run = await sweep.removePoolStaging();
    assert.equal(result(run, "wsl", job.id).result, "failed");
    assert.match(result(run, "wsl", job.id).detail ?? "", /no longer resolves/);
    assert.equal(readFileSync(join(elsewhere, job.id, "live.wav"), "utf8"), "another tree");
    assert.ok(existsSync(join(host.root, "alignment", "pool-jobs-checked", job.id)), "the checked folder was not reached either");
  } finally {
    host.holdCommand = undefined;
    // unlink, not rm: the link points at a directory, and rm refuses that on some Node versions.
    unlinkSync(poolJobs);
    renameSync(join(host.root, "alignment", "pool-jobs-checked"), poolJobs);
  }
});

test("a job row whose pool is a string or whose data is not JSON does not break the listing and can be deleted", async () => {
  const job = await finishedJob();
  const setData = (data: string) => sqlite.prepare("UPDATE alignment_jobs SET data=? WHERE id=?").run(data, job.id);
  setData(JSON.stringify({ id: job.id, status: "error", pool: "broken" }));
  assert.equal(entry(await sweep.listPoolStaging(), "wsl", job.id).action, "unknown", "no staging record: never removed");
  setData("{bad");
  assert.equal(entry(await sweep.listPoolStaging(), "wsl", job.id).action, "unknown");
  setData(JSON.stringify({ id: job.id, status: "error", pool: "broken" }));
  transition.deleteAlignmentJob(job.id);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM alignment_jobs WHERE id=?").get(job.id) as { n: number }).n, 0);
});
