// Removes audio the alignment pool staged on its hosts (#421, ADR 0013), for the administrator: a dry run lists every
// folder under each worker's `MEDIA_ROOT/alignment/pool-jobs` with its size and what a run would do; a run removes
// what the server's own records say is no longer used.
//
// Why a removal can never reach a later lease's folder: before the removal of a folder is sent, its name is retired
// in the database (`alignment_pool_retired`), in the same transaction that checks again, under the recording's lease,
// that the folder's job is finished or deleted and that no lease or run of it is live. Staging chooses its folder name
// after it has leased the host and the recording and before its first remote command, and never uses a retired name
// (`stagingName` in alignment-pool.ts). So every staging into that name began before the removal was sent, and a
// later run stages under another name: a removal that outlives its deadline, a restart, or a slow host can only reach
// a folder that nothing stages into again. A later lease reads only what it staged itself.
import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sqlite } from "./db.ts";
import {
  getAlignmentPoolCoordinator,
  poolDeps,
  setRetiredStagingNameCheck,
  shellQuote,
  stagingFolder,
  storedStaging,
  untilAborted,
  workerMediaRoot,
  type AlignmentJobPoolState,
  type PoolHost,
  type PoolHostId,
} from "./alignment-pool.ts";

/** Statuses whose job has no further use for its staging; Resume plans it again under a new folder name. */
const FINISHED_STATUSES = ["ready", "partial", "error", "cancelled"];
/** The names staging makes: a job id or a probe id, with `.r<n>` once a name was retired. */
const STAGING_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function stagingNameRetired(name: string) {
  return !!sqlite.prepare("SELECT 1 FROM alignment_pool_retired WHERE name=?").get(name);
}
setRetiredStagingNameCheck(stagingNameRetired);

export const POOL_SWEEP_LIST_TIMEOUT_MS = 30_000;
export const POOL_SWEEP_REMOVE_TIMEOUT_MS = 60_000;
let timeouts = { listMs: POOL_SWEEP_LIST_TIMEOUT_MS, removeMs: POOL_SWEEP_REMOVE_TIMEOUT_MS };
export function setPoolSweepTimeoutsForTests(value: { listMs?: number; removeMs?: number } | null) {
  timeouts = { listMs: value?.listMs ?? POOL_SWEEP_LIST_TIMEOUT_MS, removeMs: value?.removeMs ?? POOL_SWEEP_REMOVE_TIMEOUT_MS };
}

let runInFlight: (jobId: string) => boolean = () => false;
let runInFlightForTests: ((jobId: string) => boolean) | null = null;
/** Installed by alignment.ts: a run of this job is in flight in this process (between leases, too). */
export function setPoolSweepRunCheck(check: (jobId: string) => boolean) {
  runInFlight = check;
}
export function setPoolSweepRunCheckForTests(check: ((jobId: string) => boolean) | null) {
  runInFlightForTests = check;
}
const jobRunInFlight = (jobId: string) => (runInFlightForTests ?? runInFlight)(jobId);

export type StagedFolder = {
  name: string;
  path: string;
  directory: boolean;
  /** `du -sk`; null when the host could not measure it. */
  sizeKiB: number | null;
  /** "remove": a run removes it. "keep": in use, or its job may still use it. "unknown": the server has no record of it; never removed. */
  action: "remove" | "keep" | "unknown";
  reason: string;
  jobId: string | null;
  recordingId: string | null;
  status: string | null;
};
export type HostStaging = {
  hostId: PoolHostId;
  /** The worker's media root its /health reports; null when it could not be read. */
  root: string | null;
  error: string | null;
  folders: StagedFolder[];
  removableKiB: number;
};
export type PoolStagingListing = { checkedAt: number; hosts: HostStaging[] };
export type RemovalOutcome = StagedFolder & { result: "removed" | "kept" | "failed"; detail: string | null };
export type PoolStagingRemoval = {
  checkedAt: number;
  hosts: { hostId: PoolHostId; root: string | null; error: string | null; folders: RemovalOutcome[] }[];
};

type ListedEntry = { name: string; directory: boolean; sizeKiB: number | null };

/** Lists `dir` as `<d|f>\t<KiB or ->\t<name>` lines; an absent folder lists nothing. */
function listingCommand(dir: string) {
  return `dir=${shellQuote(dir)}; [ -d "$dir" ] || exit 0; cd "$dir" || exit 1; ` +
    `for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; ` +
    `if [ -d "$f" ] && [ ! -L "$f" ]; then t=d; else t=f; fi; ` +
    `s=$(du -sk -- "$f" 2>/dev/null | cut -f1); printf "%s\\t%s\\t%s\\n" "$t" "\${s:--}" "$f"; done`;
}

export function parseStagingListing(stdout: string): ListedEntry[] {
  const entries: ListedEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const size = line.slice(first + 1, second);
    entries.push({
      name: line.slice(second + 1),
      directory: line.slice(0, first) === "d",
      sizeKiB: /^\d+$/.test(size) ? Number(size) : null,
    });
  }
  return entries;
}

type JobRecord = { id: string; recordingId: string; status: string };
type Records = {
  jobs: Map<string, JobRecord>;
  /** `host\0folder` to the job whose stored assignment names it. */
  owners: Map<string, JobRecord>;
  orphans: Map<string, { jobId: string; recordingId: string }>;
};
const key = (hostId: PoolHostId, folder: string) => `${hostId}\0${folder}`;

/** What the database says now: every job's status and recorded staging, and the staging of deleted jobs. */
function readRecords(): Records {
  const records: Records = { jobs: new Map(), owners: new Map(), orphans: new Map() };
  const rows = sqlite.prepare(
    "SELECT id, recording_id, json_extract(data,'$.status') AS status, json_extract(data,'$.pool') AS pool FROM alignment_jobs",
  ).all() as { id: string; recording_id: string; status: string | null; pool: string | null }[];
  for (const row of rows) {
    const job: JobRecord = { id: row.id, recordingId: row.recording_id, status: row.status ?? "" };
    records.jobs.set(row.id, job);
    let pool: Partial<AlignmentJobPoolState> | null = null;
    try {
      pool = row.pool ? JSON.parse(row.pool) : null;
    } catch {
      pool = null;
    }
    for (const [hostId, folder] of Object.entries(storedStaging(pool))) records.owners.set(key(hostId, folder), job);
  }
  for (const row of sqlite.prepare("SELECT host_id, folder, job_id, recording_id FROM alignment_pool_orphans").all() as
    { host_id: string; folder: string; job_id: string; recording_id: string }[])
    records.orphans.set(key(row.host_id, row.folder), { jobId: row.job_id, recordingId: row.recording_id });
  return records;
}

function classify(hostId: PoolHostId, root: string, entry: ListedEntry, records: Records): StagedFolder {
  const path = stagingFolder(root, entry.name);
  const folder = { ...entry, path, jobId: null, recordingId: null, status: null };
  const verdict = (action: StagedFolder["action"], reason: string, job?: Partial<JobRecord> & { recordingId?: string }) =>
    ({ ...folder, action, reason, jobId: job?.id ?? null, recordingId: job?.recordingId ?? null, status: job?.status ?? null });
  if (!entry.directory || !STAGING_NAME.test(entry.name)) return verdict("unknown", "Not a folder the pool stages into.");
  if (getAlignmentPoolCoordinator().holdsLease(entry.name)) return verdict("keep", "In use by a running probe or job.");
  const retired = sqlite.prepare("SELECT job_id, recording_id FROM alignment_pool_retired WHERE name=?").get(entry.name) as
    { job_id: string; recording_id: string } | undefined;
  if (retired)
    return verdict("remove", "Its name was retired by an earlier removal: nothing stages into it again.",
      { id: retired.job_id, recordingId: retired.recording_id, status: records.jobs.get(retired.job_id)?.status });
  const owner = records.owners.get(key(hostId, path));
  if (owner)
    return FINISHED_STATUSES.includes(owner.status)
      ? verdict("remove", `Its job is ${owner.status}.`, owner)
      : verdict("keep", `Its job is ${owner.status || "unreadable"}: its next run uses this folder.`, owner);
  const orphan = records.orphans.get(key(hostId, path));
  if (orphan) {
    const again = records.jobs.get(orphan.jobId);
    if (again && !FINISHED_STATUSES.includes(again.status))
      return verdict("keep", `Its job was deleted and planned again (${again.status}).`, again);
    return verdict("remove", "Its job was deleted.", { id: orphan.jobId, recordingId: orphan.recordingId, status: again?.status });
  }
  return verdict("unknown", "The server has no record of this folder.");
}

/** The worker's root, refused when it lies inside a pool-jobs folder: a removal there could reach another root. */
async function hostRoot(host: PoolHost, signal: AbortSignal) {
  const root = (await workerMediaRoot(host, signal)).replace(/(.)\/+$/, "$1");
  if (normalize(root) !== root) throw new Error("worker media root is not a normal path");
  if (`${root}/`.includes("/alignment/pool-jobs/")) throw new Error("worker media root lies inside a pool-jobs folder");
  return root;
}

async function listHost(host: PoolHost): Promise<HostStaging> {
  const signal = AbortSignal.timeout(timeouts.listMs);
  try {
    const root = await hostRoot(host, signal);
    const dir = stagingFolder(root, "");
    const { stdout } = await untilAborted(poolDeps().exec(host.sshTarget, listingCommand(dir), { signal }), signal);
    const records = readRecords();
    const folders = parseStagingListing(stdout).map((entry) => classify(host.id, root, entry, records))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { hostId: host.id, root, error: null, folders, removableKiB: removable(folders) };
  } catch (error) {
    return { hostId: host.id, root: null, error: failure(error), folders: [], removableKiB: 0 };
  }
}

const removable = (folders: StagedFolder[]) =>
  folders.reduce((sum, folder) => sum + (folder.action === "remove" ? folder.sizeKiB ?? 0 : 0), 0);

function failure(error: unknown) {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
  const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${message}${cause}`.replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown failure";
}

function selectedHosts(hostId?: string) {
  const hosts = getAlignmentPoolCoordinator().listHosts();
  if (!hostId) return hosts;
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (!host) throw Object.assign(new Error(`No pool host is configured as ${hostId}.`), { statusCode: 400 });
  return [host];
}

/** The dry run: every folder on every configured host, its size and what a run would do. Removes nothing. */
export async function listPoolStaging(options: { host?: string } = {}): Promise<PoolStagingListing> {
  const hosts = selectedHosts(options.host);
  return { checkedAt: Date.now(), hosts: await Promise.all(hosts.map((host) => listHost(host))) };
}

/**
 * Under the recording's lease, in one write transaction: classify the folder again from the database, check that
 * no lease or run of its job is live, and retire its name. Returns why it is kept, or null when the name is retired
 * and the removal may be sent.
 */
function retireUnderLease(hostId: PoolHostId, root: string, listed: StagedFolder, recordingId: string, holder: string) {
  const coord = getAlignmentPoolCoordinator();
  const level = sqlite.pragma("synchronous", { simple: true }) as number;
  // The retirement must be on disk before the removal leaves: FULL syncs the write-ahead log on commit.
  if (level < 2) sqlite.pragma("synchronous = FULL");
  try {
    return sqlite.transaction((): string | null => {
      const now = classify(hostId, root, listed, readRecords());
      if (now.action !== "remove") return `Checked again under the lease: ${now.reason}`;
      if (now.jobId !== listed.jobId || now.recordingId !== recordingId) return "Its record changed since the listing.";
      if (!coord.holdsLease(holder)) return "The sweep no longer holds its recording's lease.";
      if (now.jobId && coord.holdsLease(now.jobId)) return "Its job holds a lease.";
      if (now.jobId && jobRunInFlight(now.jobId)) return "A run of its job is in flight.";
      sqlite.prepare("INSERT OR IGNORE INTO alignment_pool_retired(name,job_id,recording_id,retired_at) VALUES(?,?,?,?)")
        .run(listed.name, now.jobId ?? "", recordingId, Date.now());
      return null;
    }).immediate();
  } finally {
    if (level < 2) sqlite.pragma(`synchronous = ${level}`);
  }
}

async function removeFolder(host: PoolHost, root: string, folder: StagedFolder): Promise<RemovalOutcome> {
  const kept = (detail: string): RemovalOutcome => ({ ...folder, result: "kept", detail });
  const coord = getAlignmentPoolCoordinator();
  const path = stagingFolder(root, folder.name);
  if (!STAGING_NAME.test(folder.name) || folder.path !== path || !isAbsolute(path)) return kept("Not a folder the pool stages into.");
  const recordingId = folder.recordingId;
  if (!recordingId) return kept("No recording to lease.");
  const holder = `pool-sweep-${randomUUID()}`;
  if (!coord.holdRecording(recordingId, holder)) return kept("Its recording is leased by a running job or probe.");
  try {
    const reason = retireUnderLease(host.id, root, folder, recordingId, holder);
    if (reason) return kept(reason);
    // The name is retired: from here on nothing stages into it, so this removal may run as late as it likes.
    const signal = AbortSignal.timeout(timeouts.removeMs);
    try {
      await untilAborted(poolDeps().exec(host.sshTarget, `rm -rf -- ${shellQuote(path)}`, { signal }), signal);
    } catch (error) {
      return { ...folder, result: "failed", detail: `${failure(error)} The name stays retired; a later run removes the folder.` };
    }
    sqlite.prepare("DELETE FROM alignment_pool_orphans WHERE host_id=? AND folder=?").run(host.id, path);
    return { ...folder, result: "removed", detail: null };
  } finally {
    coord.releaseRecording(recordingId, holder);
  }
}

let removing = false;

/**
 * The real run: lists each host again, then removes every folder the listing marks for removal, one at a time per
 * host, each under its recording's lease and checked again just before. Unknown folders are never removed.
 */
export async function removePoolStaging(options: { host?: string } = {}): Promise<PoolStagingRemoval> {
  if (removing) throw Object.assign(new Error("A staging removal is already running."), { statusCode: 409 });
  removing = true;
  try {
    const hosts = selectedHosts(options.host);
    const listed = await Promise.all(hosts.map(async (host) => {
      const listing = await listHost(host);
      const folders: RemovalOutcome[] = [];
      for (const folder of listing.folders)
        folders.push(folder.action === "remove" && listing.root
          ? await removeFolder(host, listing.root, folder)
          : { ...folder, result: "kept", detail: null });
      return { hostId: host.id, root: listing.root, error: listing.error, folders };
    }));
    return { checkedAt: Date.now(), hosts: listed };
  } finally {
    removing = false;
  }
}

/** Admin only (also listed in the preHandler of server/app.ts). */
export function registerPoolStagingRoutes(app: FastifyInstance, deps: { requireAdmin: (req: FastifyRequest) => void }) {
  const hostQuery = z.object({ host: z.string().min(1).optional() }).passthrough();
  app.get("/api/alignments/pool/staging", async (req) => {
    deps.requireAdmin(req);
    return listPoolStaging(hostQuery.parse(req.query ?? {}));
  });
  app.post("/api/alignments/pool/staging/remove", async (req) => {
    deps.requireAdmin(req);
    return removePoolStaging(hostQuery.parse(req.body ?? {}));
  });
}
