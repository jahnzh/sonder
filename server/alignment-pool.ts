// SSH pool for full (anchored) alignment jobs: isolated staging, host caps, one cross-host retry.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AlignmentJob } from "../src/reading-types.ts";
import type * as schema from "./schema.ts";

const execFileAsync = promisify(execFile);

export type PoolHostId = "wsl" | "steamdeck";

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
  return poolEnabled() && isFullAlignmentJob(job);
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
      .filter((host) => !exclude.includes(host.id))
      .map((host) => ({
        host,
        free: host.maxConcurrent - this.activeOnHost(host.id),
      }))
      .filter((row) => row.free > 0)
      .sort((a, b) => b.free - a.free);
    return candidates[0]?.host ?? null;
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

export async function dispatchFullAlignmentJob(
  job: AlignmentJob,
  tracks: (typeof schema.tracks.$inferSelect)[],
  localAudio: (track: typeof schema.tracks.$inferSelect) => string | null,
  triedHosts: PoolHostId[] = job.pool?.triedHosts ?? [],
): Promise<AlignmentJobPoolState> {
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
