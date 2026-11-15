// The one-time sweep of staged folders (ADR 0013): only folders whose job is finished or gone are removed, and
// --dry-run only lists them. Runs against the in-process fake pool hosts; it never reaches WSL or lisa.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetAlignmentPoolCoordinator, setAlignmentPoolDepsForTests, type PoolHost } from "../server/alignment-pool.ts";
import { parseSweepArgs, PROBE_FOLDER_MIN_AGE_MS, sweepPoolStaging } from "../server/alignment-pool-sweep.ts";
import { fakePoolHosts, type FakePool } from "./fake-pool-host.ts";

const originalFetch = globalThis.fetch;
const temps: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  setAlignmentPoolDepsForTests(null);
  resetAlignmentPoolCoordinator();
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-15T12:00:00Z");
const STATUSES: Record<string, string> = {
  "job-ready": "ready", "job-partial": "partial", "job-error": "error", "job-cancelled": "cancelled",
  "job-queued": "queued", "job-copying": "copying", "job-processing": "processing", "job-paused": "paused",
};

function setup(): { fake: FakePool; hosts: PoolHost[] } {
  const temp = mkdtempSync(join(tmpdir(), "sonder-pool-sweep-"));
  temps.push(temp);
  const fake = fakePoolHosts(temp);
  setAlignmentPoolDepsForTests(fake.deps);
  globalThis.fetch = fake.fetch;
  const hosts = Object.values(fake.hosts).map((host, index): PoolHost => ({
    id: host.id, sshTarget: host.sshTarget, workerUrl: host.workerUrl, device: host.device, precision: host.precision,
    rank: index + 1, maxConcurrent: 1, remoteWorkRoot: host.root,
  }));
  const stage = (hostId: string, name: string, ageMs = 0) => {
    const folder = join(fake.hosts[hostId].root, "alignment", "pool-jobs", name);
    mkdirSync(join(folder, "tracks"), { recursive: true });
    writeFileSync(join(folder, "tracks", "t1"), "audio");
    const seconds = (NOW - ageMs) / 1000;
    utimesSync(folder, seconds, seconds);
  };
  for (const name of [...Object.keys(STATUSES), "job-gone"]) stage("wsl", name);
  stage("wsl", "ctc-probe-old", PROBE_FOLDER_MIN_AGE_MS + 60_000);
  stage("wsl", "ctc-probe-new", 60_000);
  stage("wsl", "-not-a-job-id");
  stage("lisa", "job-gone-on-lisa");
  stage("lisa", "job-processing");
  // Something else under the worker's media root is never touched.
  mkdirSync(join(fake.hosts.wsl.root, "alignment", "models"), { recursive: true });
  return { fake, hosts };
}

const sweep = (hosts: PoolHost[], dryRun: boolean, log?: (line: string) => void) =>
  sweepPoolStaging({ dryRun, hosts, now: () => NOW, jobStatus: (id) => STATUSES[id] ?? null, log });

const REMOVED_ON_WSL = ["ctc-probe-old", "job-cancelled", "job-error", "job-gone", "job-partial", "job-ready"];
const KEPT_ON_WSL = ["-not-a-job-id", "ctc-probe-new", "job-copying", "job-paused", "job-processing", "job-queued"];

test("a dry run lists the folders of finished or gone jobs and old probes, and removes nothing", async () => {
  const { fake, hosts } = setup();
  const lines: string[] = [];
  const reports = await sweep(hosts, true, (line) => lines.push(line));
  const [wsl, lisa] = reports;
  assert.equal(wsl.mediaRoot, fake.hosts.wsl.root);
  assert.deepEqual(wsl.remove.map((folder) => folder.name), REMOVED_ON_WSL);
  assert.deepEqual(wsl.keep.map((folder) => folder.name).sort(), KEPT_ON_WSL);
  assert.deepEqual(Object.fromEntries(wsl.remove.map((folder) => [folder.name, folder.reason])), {
    "ctc-probe-old": "probe, older than an hour", "job-cancelled": "job cancelled", "job-error": "job error",
    "job-gone": "job gone", "job-partial": "job partial", "job-ready": "job ready",
  });
  assert.equal(wsl.keep.find((folder) => folder.name === "job-paused")?.reason, "job paused");
  assert.equal(wsl.keep.find((folder) => folder.name === "-not-a-job-id")?.reason, "unexpected name");
  assert.deepEqual(lisa.remove.map((folder) => folder.name), ["job-gone-on-lisa"]);
  assert.ok(lines.includes(`wsl: would remove ${join(fake.hosts.wsl.root, "alignment", "pool-jobs", "job-ready")} (job ready)`), lines.join("\n"));
  // Nothing removed: every folder is still there and no rm ran.
  assert.deepEqual(fake.stagedFolders("wsl"), [...REMOVED_ON_WSL, ...KEPT_ON_WSL].sort());
  assert.ok(![...fake.hosts.wsl.commands, ...fake.hosts.lisa.commands].some((command) => command.includes("rm ")));
});

test("the sweep removes only the folders of finished or gone jobs and old probes", async () => {
  const { fake, hosts } = setup();
  const reports = await sweep(hosts, false);
  assert.deepEqual(reports.map((report) => report.failed), [[], []]);
  assert.deepEqual(fake.stagedFolders("wsl"), [...KEPT_ON_WSL].sort());
  assert.deepEqual(fake.stagedFolders("lisa"), ["job-processing"]);
  assert.ok(existsSync(join(fake.hosts.wsl.root, "alignment", "models")));
  // A second run finds nothing more to remove.
  const again = await sweep(hosts, false);
  assert.deepEqual(again.map((report) => report.remove.length), [0, 0]);
});

test("a host that does not answer is reported and skipped; the others are still swept", async () => {
  const { fake, hosts } = setup();
  fake.hosts.wsl.down = true;
  const [wsl, lisa] = await sweep(hosts, false);
  assert.match(wsl.error ?? "", /media root is unknown/);
  assert.equal(wsl.remove.length, 0);
  assert.equal(fake.stagedFolders("wsl").length, REMOVED_ON_WSL.length + KEPT_ON_WSL.length);
  assert.deepEqual(lisa.remove.map((folder) => folder.name), ["job-gone-on-lisa"]);
  fake.hosts.wsl.down = false;
  fake.hosts.wsl.sshDown = true;
  const [listingFailed] = await sweep(hosts, false);
  assert.match(listingFailed.error ?? "", /^listing .* failed/);
});

test("the sweep command takes --dry-run and refuses anything else", () => {
  assert.deepEqual(parseSweepArgs([]), { dryRun: false, help: false });
  assert.deepEqual(parseSweepArgs(["--dry-run"]), { dryRun: true, help: false });
  assert.throws(() => parseSweepArgs(["--dryrun"]), /Unknown option: --dryrun/);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "server/alignment-pool-sweep.ts", ...args],
    { cwd: repo, encoding: "utf8", env: { ...process.env, DATA_DIR: join(tmpdir(), "sonder-sweep-no-such-dir") } });
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--dry-run\s+list what would be removed and remove nothing/);
  const wrong = run("--force");
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /Unknown option: --force/);
});
