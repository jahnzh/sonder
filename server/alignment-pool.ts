// SSH pool for full (anchored) alignment jobs: isolated staging, host caps, one cross-host retry.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AlignmentJob } from "../src/reading-types.ts";
import type * as schema from "./schema.ts";

const execFileAsync = promisify(execFile);

export type PoolHostId = "wsl" | "steamdeck" | "lisa";
export const CTC_ENGINE = "ctc-wav2vec2-base-960h-torchaudio-2.8-v1";

export type AlignmentJobPoolState = {
  hostId: PoolHostId;
  attempt: number;
  jobMediaRoot: string;
  workerUrl: string;
  triedHosts: PoolHostId[];
  stagedAudio: Record<string, string>;
};

export type PoolHost = {
  id: PoolHostId;
  sshTarget: string;
  maxConcurrent: number;
  remoteWorkRoot: string;
  workerUrl: string;
};

export type PoolSshDeps = {
  exec: (
    sshTarget: string,
    command: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  uploadFile: (localPath: string, remotePath: string, sshTarget: string) => Promise<void>;
  probe: (sshTarget: string) => Promise<boolean>;
};

export type StageTracksInput = {
  jobId: string;
  host: PoolHost;
  tracks: (typeof schema.tracks.$inferSelect)[];
  localAudio: (track: typeof schema.tracks.$inferSelect) => string | null;
};

const POOL_FAILURE_MESSAGE =
  "Remote alignment failed on all pool hosts. Resume to retry.";

export function poolEnabled() {
  return process.env.ALIGNMENT_POOL_ENABLED === "1";
}

export function isFullAlignmentJob(job: AlignmentJob) {
  return job.mode === "anchored" && job.origin !== "projected";
}

export function shouldDispatchToPool(job: AlignmentJob) {
  return poolEnabled() && job.origin !== "projected" &&
    (job.engine === CTC_ENGINE || isFullAlignmentJob(job));
}

function hostNameFromSshTarget(sshTarget: string) {
  const at = sshTarget.lastIndexOf("@");
  return at >= 0 ? sshTarget.slice(at + 1) : sshTarget;
}

export function defaultPoolHosts(): PoolHost[] {
  const workRoot =
    process.env.ALIGNMENT_POOL_REMOTE_ROOT ??
    "~/sonder-replication/alignment-pool";
  const wslHost = process.env.ALIGNMENT_POOL_WSL_HOST ?? "192.168.1.119";
  const deckHost = process.env.ALIGNMENT_POOL_DECK_HOST ?? "deck@steamdeck";
  const lisaHost = process.env.ALIGNMENT_POOL_LISA_HOST ?? "lisa";
  return [
    {
      id: "wsl",
      sshTarget: wslHost,
      maxConcurrent: 3,
      remoteWorkRoot: workRoot,
      workerUrl:
        process.env.ALIGNMENT_POOL_WSL_WORKER_URL ??
        `http://${hostNameFromSshTarget(wslHost)}:3012`,
    },
    {
      id: "steamdeck",
      sshTarget: deckHost,
      maxConcurrent: 1,
      remoteWorkRoot: workRoot,
      workerUrl:
        process.env.ALIGNMENT_POOL_DECK_WORKER_URL ??
        `http://${hostNameFromSshTarget(deckHost)}:3012`,
    },
    {
      id: "lisa",
      sshTarget: lisaHost,
      maxConcurrent: 1,
      remoteWorkRoot: workRoot,
      workerUrl:
        process.env.ALIGNMENT_POOL_LISA_WORKER_URL ??
        `http://${hostNameFromSshTarget(lisaHost)}:3012`,
    },
  ];
}

export function sharedAlignmentModelsRoot(host: PoolHost) {
  return (
    process.env.ALIGNMENT_POOL_REMOTE_MODELS_ROOT ??
    `${host.remoteWorkRoot}/shared/alignment`
  );
}

export function isolatedJobMediaRoot(host: PoolHost, jobId: string) {
  return `${host.remoteWorkRoot}/jobs/${jobId}/media`;
}

export function isolatedAlignmentFolder(host: PoolHost, jobId: string) {
  return `${isolatedJobMediaRoot(host, jobId)}/alignment/${jobId}`;
}

let depsOverride: PoolSshDeps | null = null;

export function setAlignmentPoolDepsForTests(deps: PoolSshDeps | null) {
  depsOverride = deps;
}

function defaultPoolSshDeps(): PoolSshDeps {
  const exec = async (sshTarget: string, command: string) => {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sshTarget, command],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  };
  return {
    exec,
    async uploadFile(localPath, remotePath, sshTarget) {
      await execFileAsync(
        "scp",
        [
          "-q",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          localPath,
          `${sshTarget}:${remotePath}`,
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      );
    },
    async probe(sshTarget) {
      try {
        await exec(sshTarget, "true");
        return true;
      } catch {
        return false;
      }
    },
  };
}

function poolDeps(): PoolSshDeps {
  if (depsOverride) return depsOverride;
  return defaultPoolSshDeps();
}

type RecordingLease = { jobId: string; site: "local" | "remote" };

export class AlignmentPoolCoordinator {
  private slots = new Map<PoolHostId, Set<string>>();
  private recordings = new Map<string, RecordingLease>();
  private localJobs = new Set<string>();
  private readonly maxLocalConcurrent = 1;
  constructor(private hosts: PoolHost[] = defaultPoolHosts()) {}

  reset() {
    this.slots.clear();
    this.recordings.clear();
    this.localJobs.clear();
  }

  hostById(id: PoolHostId) {
    return this.hosts.find((host) => host.id === id);
  }

  activeOnHost(hostId: PoolHostId) {
    return this.slots.get(hostId)?.size ?? 0;
  }

  hasJobLease(hostId: PoolHostId, jobId: string) {
    return this.slots.get(hostId)?.has(jobId) ?? false;
  }

  canUseLocalWorker(recordingId: string) {
    const lease = this.recordings.get(recordingId);
    return !lease || lease.site === "local";
  }

  tryAcquireLocal(jobId: string) {
    if (this.localJobs.size >= this.maxLocalConcurrent) return false;
    this.localJobs.add(jobId);
    return true;
  }

  releaseLocal(jobId: string) {
    this.localJobs.delete(jobId);
  }

  localFullAlignmentStarting(recordingId: string, jobId: string) {
    const lease = this.recordings.get(recordingId);
    if (lease && lease.site === "remote")
      throw new Error(
        "This recording is being aligned on a remote pool host.",
      );
    this.recordings.set(recordingId, { jobId, site: "local" });
  }

  localFullAlignmentFinished(recordingId: string, jobId: string) {
    const lease = this.recordings.get(recordingId);
    if (lease?.jobId === jobId && lease.site === "local")
      this.recordings.delete(recordingId);
  }

  selectHost(exclude: PoolHostId[] = []) {
    const candidates = this.hosts
      .filter((host) => host.id !== "lisa" && !exclude.includes(host.id))
      .map((host) => ({
        host,
        free: host.maxConcurrent - this.activeOnHost(host.id),
      }))
      .filter((row) => row.free > 0)
      .sort((a, b) => b.free - a.free);
    return candidates[0]?.host ?? null;
  }

  // Each worker reports one busy/free gate. Reserve it across the whole job,
  // including gaps between its individual HTTP requests.
  tryAcquireCtc(hostId: PoolHostId, jobId: string, recordingId: string) {
    if (this.activeOnHost(hostId) > 0) return false;
    const lease = this.recordings.get(recordingId);
    if (lease && (lease.jobId !== jobId || lease.site === "local")) return false;
    if (!this.hostById(hostId)) return false;
    this.slots.set(hostId, new Set([jobId]));
    this.recordings.set(recordingId, { jobId, site: "remote" });
    return true;
  }

  tryAcquire(hostId: PoolHostId, jobId: string, recordingId: string) {
    const host = this.hostById(hostId);
    if (!host) return false;
    const lease = this.recordings.get(recordingId);
    if (lease && (lease.jobId !== jobId || lease.site === "local"))
      return false;
    const active = this.slots.get(hostId) ?? new Set<string>();
    if (active.size >= host.maxConcurrent) return false;
    active.add(jobId);
    this.slots.set(hostId, active);
    this.recordings.set(recordingId, { jobId, site: "remote" });
    return true;
  }

  release(hostId: PoolHostId, jobId: string, recordingId: string) {
    this.slots.get(hostId)?.delete(jobId);
    const lease = this.recordings.get(recordingId);
    if (lease?.jobId === jobId && lease.site === "remote")
      this.recordings.delete(recordingId);
  }
}

let coordinator = new AlignmentPoolCoordinator();

export function getAlignmentPoolCoordinator() {
  return coordinator;
}

export function resetAlignmentPoolCoordinator(hosts?: PoolHost[]) {
  coordinator = new AlignmentPoolCoordinator(hosts);
}

export async function stageTracksOnHost(input: StageTracksInput) {
  const mediaRoot = isolatedJobMediaRoot(input.host, input.jobId);
  const modelsRoot = sharedAlignmentModelsRoot(input.host);
  const deps = poolDeps();
  await deps.exec(
    input.host.sshTarget,
    `mkdir -p '${mediaRoot}/tracks' '${mediaRoot}/alignment/${input.jobId}' && ` +
      `if [ -e '${modelsRoot}/models' ]; then ln -sfn '${modelsRoot}/models' '${mediaRoot}/alignment/models'; fi`,
  );
  const stagedAudio: Record<string, string> = {};
  for (const track of input.tracks) {
    const local = input.localAudio(track);
    if (!local) continue;
    const remote = `${mediaRoot}/tracks/${track.id}${local.endsWith(".mp3") ? ".mp3" : ""}`;
    await deps.uploadFile(local, remote, input.host.sshTarget);
    stagedAudio[track.id] = remote;
  }
  return { jobMediaRoot: mediaRoot, stagedAudio };
}

/** Local test stub: copy into a temp tree instead of SSH. */
export async function stageTracksLocally(
  baseDir: string,
  jobId: string,
  tracks: (typeof schema.tracks.$inferSelect)[],
  localAudio: (track: typeof schema.tracks.$inferSelect) => string | null,
) {
  const jobMediaRoot = join(baseDir, "jobs", jobId, "media");
  mkdirSync(join(jobMediaRoot, "alignment", jobId), { recursive: true });
  const stagedAudio: Record<string, string> = {};
  for (const track of tracks) {
    const local = localAudio(track);
    if (!local) continue;
    const dest = join(jobMediaRoot, "tracks", track.id);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(local, dest);
    stagedAudio[track.id] = dest;
  }
  return { jobMediaRoot, stagedAudio };
}

export class PoolBusyError extends Error {
  constructor(readonly triedHosts: PoolHostId[] = []) {
    super("The remote alignment workers are busy.");
  }
}

type CtcHealth = {
  ready: boolean;
  mediaRoot: string;
  busy: boolean;
  stuck: boolean;
  ctc: { engine: string; ready: boolean; device: string; precision: string; anchorReady: boolean };
};

function workerOrigin(value: string) {
  const url = new URL(value);
  const hostname = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? "loopback" : url.hostname;
  return `${url.protocol}//${hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

async function ctcHealth(host: PoolHost): Promise<CtcHealth | null> {
  try {
    // A pool URL accidentally pointed at the local worker must never send it
    // CTC, even if that worker happens to advertise a compatible CPU runtime.
    const hostname = new URL(host.workerUrl).hostname;
    if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return null;
    const localWorker = process.env.ALIGNMENT_WORKER_URL;
    if (localWorker && workerOrigin(host.workerUrl) === workerOrigin(localWorker)) return null;
    const response = await fetch(`${host.workerUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const health = await response.json() as CtcHealth;
    if (!health || health.ready !== true || typeof health.mediaRoot !== "string" || !isAbsolute(health.mediaRoot) ||
        typeof health.busy !== "boolean" || typeof health.stuck !== "boolean" ||
        !health.ctc || health.ctc.engine !== CTC_ENGINE || health.ctc.ready !== true ||
        health.ctc.device !== (host.id === "wsl" ? "cuda" : "cpu") ||
        health.ctc.precision !== (host.id === "wsl" ? "float16" : "float32")) return null;
    return health;
  } catch {
    return null;
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

async function stageCtcTracks(input: StageTracksInput, workerRoot: string) {
  // The worker validates outputs against MEDIA_ROOT/alignment. Both the audio
  // and per-job output must therefore be inside its reported root.
  const jobMediaRoot = join(workerRoot, "alignment", "pool-jobs", input.jobId);
  const folder = join(jobMediaRoot, "alignment", input.jobId);
  const deps = poolDeps();
  await deps.exec(input.host.sshTarget,
    `mkdir -p ${shellQuote(join(jobMediaRoot, "tracks"))} ${shellQuote(folder)}`);
  const stagedAudio: Record<string, string> = {};
  for (const track of input.tracks) {
    const local = input.localAudio(track);
    if (!local) continue;
    const remote = join(jobMediaRoot, "tracks", encodeURIComponent(track.id));
    await deps.uploadFile(local, remote, input.host.sshTarget);
    stagedAudio[track.id] = remote;
  }
  return { jobMediaRoot, stagedAudio };
}

async function dispatchCtcJob(
  job: AlignmentJob,
  tracks: (typeof schema.tracks.$inferSelect)[],
  localAudio: StageTracksInput["localAudio"],
  triedHosts: PoolHostId[],
): Promise<AlignmentJobPoolState> {
  const coord = getAlignmentPoolCoordinator();
  let busy = false;
  // Older anchored jobs could carry a Steam Deck attempt; it is not one of
  // the two eligible CTC hosts and must not consume the CTC retry.
  const attempted = triedHosts.filter((id) => id === "wsl" || id === "lisa");
  for (const id of ["wsl", "lisa"] as const) {
    if (attempted.includes(id)) continue;
    const host = coord.hostById(id);
    if (!host) continue;
    const health = await ctcHealth(host);
    if (!health || (job.mode === "anchored" && health.ctc.anchorReady !== true)) continue;
    if (health.busy || health.stuck || coord.activeOnHost(id) > 0) {
      busy = true;
      continue;
    }
    if (!(await poolDeps().probe(host.sshTarget))) continue;
    if (!coord.tryAcquireCtc(id, job.id, job.recordingId)) {
      busy = true;
      continue;
    }
    try {
      const staged = await stageCtcTracks({ jobId: job.id, host, tracks, localAudio }, health.mediaRoot);
      job.ctcDevice = health.ctc.device;
      job.ctcPrecision = health.ctc.precision;
      return { hostId: id, attempt: attempted.length + 1, ...staged,
        workerUrl: host.workerUrl, triedHosts: [...attempted, id] };
    } catch {
      coord.release(id, job.id, job.recordingId);
      attempted.push(id);
    }
  }
  if (busy) throw new PoolBusyError(attempted);
  throw new Error(POOL_FAILURE_MESSAGE);
}

export async function dispatchFullAlignmentJob(
  job: AlignmentJob,
  tracks: (typeof schema.tracks.$inferSelect)[],
  localAudio: (track: typeof schema.tracks.$inferSelect) => string | null,
  triedHosts: PoolHostId[] = job.pool?.triedHosts ?? [],
): Promise<AlignmentJobPoolState> {
  if (job.engine === CTC_ENGINE)
    return dispatchCtcJob(job, tracks, localAudio, triedHosts);
  const coord = getAlignmentPoolCoordinator();
  const exclude = [...triedHosts];
  for (let attempts = 0; attempts < 2; attempts++) {
    const host = coord.selectHost(exclude);
    if (!host) break;
    if (!(await poolDeps().probe(host.sshTarget))) {
      exclude.push(host.id);
      continue;
    }
    if (!coord.tryAcquire(host.id, job.id, job.recordingId)) {
      exclude.push(host.id);
      continue;
    }
    try {
      const staged = await stageTracksOnHost({
        jobId: job.id,
        host,
        tracks,
        localAudio,
      });
      return {
        hostId: host.id,
        attempt: triedHosts.length + 1,
        jobMediaRoot: staged.jobMediaRoot,
        workerUrl: host.workerUrl,
        triedHosts: [...triedHosts, host.id],
        stagedAudio: staged.stagedAudio,
      };
    } catch {
      coord.release(host.id, job.id, job.recordingId);
      exclude.push(host.id);
    }
  }
  throw new Error(POOL_FAILURE_MESSAGE);
}

export function poolFailureMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return POOL_FAILURE_MESSAGE;
}

export function poolWorkerBase(job: AlignmentJob) {
  if (job.engine === CTC_ENGINE &&
      (!job.pool?.workerUrl || !["wsl", "lisa"].includes(job.pool.hostId)))
    throw new Error("CTC alignment requires a remote pool worker.");
  return job.pool?.workerUrl ?? process.env.ALIGNMENT_WORKER_URL ?? "";
}

export function poolAudioPath(
  job: AlignmentJob,
  track: typeof schema.tracks.$inferSelect,
  localAudio: (track: typeof schema.tracks.$inferSelect) => string | null,
) {
  if (job.pool?.stagedAudio[track.id]) return job.pool.stagedAudio[track.id];
  return localAudio(track);
}

/** Local alignment cache directory (never a remote SSH path). */
export function poolAlignmentFolder(_job: AlignmentJob, localFolder: string) {
  return localFolder;
}

export function poolRemoteAlignmentFolder(job: AlignmentJob) {
  if (!job.pool?.jobMediaRoot) return null;
  return `${job.pool.jobMediaRoot}/alignment/${job.id}`;
}

export function poolJobNeedsStaging(job: AlignmentJob) {
  return shouldDispatchToPool(job) && !job.pool?.jobMediaRoot;
}

export function clearPoolStaging(job: AlignmentJob, triedHosts: PoolHostId[]) {
  job.pool = {
    hostId: "wsl",
    attempt: triedHosts.length,
    jobMediaRoot: "",
    workerUrl: "",
    triedHosts,
    stagedAudio: {},
  };
}

export { POOL_FAILURE_MESSAGE };
