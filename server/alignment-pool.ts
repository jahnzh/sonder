// The alignment pool (ADR 0013): it hands out worker leases. A lease is a healthy host with the work's tracks
// staged on it and the worker's address; health checks, slots, SSH staging, the choice of host, the retry on the
// next host and the record of where a job staged all happen here. Hosts come from configuration (`ALIGNMENT_POOL_HOSTS`).
// A job's staged audio stays on the hosts until the administrator's sweep removes it (#421, alignment-pool-sweep.ts),
// which retires the folder's name first: staging never uses a retired name again. A probe's release removes its own.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  AlignmentJob,
  AlignmentPoolHostId,
  AlignmentPoolHostStatus,
  AlignmentPoolStatus,
} from "../src/reading-types.ts";
import { CTC_ENGINE } from "./alignment-engine.ts";
import { untilAborted } from "./until-aborted.ts";
import type * as schema from "./schema.ts";

const execFileAsync = promisify(execFile);

export type PoolHostId = AlignmentPoolHostId;
export { CTC_ENGINE, untilAborted };

export type AlignmentJobPoolState = {
  hostId: PoolHostId;
  attempt: number;
  jobMediaRoot: string;
  workerUrl: string;
  triedHosts: PoolHostId[];
  stagedAudio: Record<string, string>;
  /**
   * Every host this job has staged its tracks on, and the folder there, across runs, requeues, Resume and a new
   * plan, also for a host that is not configured right now. The sweep (#421) reads it to find what it may remove.
   * Rows written before it name only their current staging (`hostId`/`jobMediaRoot`).
   */
  stagedHosts?: Record<PoolHostId, string>;
};

/** One pool host, as the configuration describes it. */
export type PoolHost = {
  id: PoolHostId;
  sshTarget: string;
  workerUrl: string;
  /** The CTC device and precision the worker must report on `/health`. */
  device: string;
  precision: string;
  /** Hosts are tried in rank order, lowest first. */
  rank: number;
  maxConcurrent: number;
  remoteWorkRoot: string;
};

/** `signal` ends the SSH/SCP child process when a caller's deadline passes. */
export type PoolSshOptions = { signal?: AbortSignal };

export type PoolSshDeps = {
  exec: (
    sshTarget: string,
    command: string,
    options?: PoolSshOptions,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  uploadFile: (localPath: string, remotePath: string, sshTarget: string, options?: PoolSshOptions) => Promise<void>;
  probe: (sshTarget: string, options?: PoolSshOptions) => Promise<boolean>;
};

function withDeadline(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

type Track = typeof schema.tracks.$inferSelect;

export type StageTracksInput = {
  jobId: string;
  /** The folder's name under `pool-jobs`: the job's id, or a new name once the sweep retired that one (#421). */
  folderName?: string;
  host: PoolHost;
  tracks: Track[];
  localAudio: (track: Track) => string | null;
};

const POOL_FAILURE_MESSAGE =
  "Remote alignment failed on all pool hosts. Resume to retry.";

/**
 * Hosts a job tries per round, however many are configured: the first, then one retry on another host. Resume
 * starts a new round. Probes are not capped here; their session caps its own retries.
 */
const JOB_HOST_ATTEMPTS = 2;

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

/**
 * The pool hosts, in rank order. `ALIGNMENT_POOL_HOSTS` (a JSON array of `{id, sshTarget, workerUrl, device,
 * precision, rank?, maxConcurrent?, remoteWorkRoot?}`) replaces the default, which is today's two hosts: WSL's GPU
 * first, lisa's CPU second, with their SSH targets and worker URLs from the `ALIGNMENT_POOL_WSL_*` and
 * `ALIGNMENT_POOL_LISA_*` settings. Throws on a setting that is not a valid host list.
 */
export function defaultPoolHosts(): PoolHost[] {
  const workRoot =
    process.env.ALIGNMENT_POOL_REMOTE_ROOT ??
    "~/sonder-replication/alignment-pool";
  const raw = process.env.ALIGNMENT_POOL_HOSTS?.trim();
  if (raw) return byRank(parsePoolHosts(raw, workRoot));
  const wslHost = process.env.ALIGNMENT_POOL_WSL_HOST ?? "192.168.1.119";
  const lisaHost = process.env.ALIGNMENT_POOL_LISA_HOST ?? "lisa";
  return [
    {
      id: "wsl",
      sshTarget: wslHost,
      device: "cuda",
      precision: "float16",
      rank: 1,
      maxConcurrent: 3,
      remoteWorkRoot: workRoot,
      workerUrl:
        process.env.ALIGNMENT_POOL_WSL_WORKER_URL ??
        `http://${hostNameFromSshTarget(wslHost)}:3012`,
    },
    {
      id: "lisa",
      sshTarget: lisaHost,
      device: "cpu",
      precision: "float32",
      rank: 2,
      maxConcurrent: 1,
      remoteWorkRoot: workRoot,
      workerUrl:
        process.env.ALIGNMENT_POOL_LISA_WORKER_URL ??
        `http://${hostNameFromSshTarget(lisaHost)}:3012`,
    },
  ];
}

const HOST_FIELDS = ["id", "sshTarget", "workerUrl", "device", "precision", "rank", "maxConcurrent", "remoteWorkRoot"];

// Plain checks, no schema library: the deploy's image smoke loads this module on its own.
function parsePoolHosts(raw: string, workRoot: string): PoolHost[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`ALIGNMENT_POOL_HOSTS is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(value) || !value.length) throw new Error("ALIGNMENT_POOL_HOSTS must be a non-empty JSON array of hosts.");
  const hosts = value.map((entry: unknown, index): PoolHost => {
    const at = `ALIGNMENT_POOL_HOSTS[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} is not an object.`);
    const host = entry as Record<string, unknown>;
    const unknown = Object.keys(host).find((key) => !HOST_FIELDS.includes(key));
    if (unknown) throw new Error(`${at}.${unknown} is not a host setting.`);
    const text = (key: string, optional = false) => {
      const field = host[key];
      if (field === undefined && optional) return undefined;
      if (typeof field !== "string" || !field.trim()) throw new Error(`${at}.${key} must be a non-empty string.`);
      return field;
    };
    const integer = (key: string, min: number) => {
      const field = host[key];
      if (field === undefined) return undefined;
      if (typeof field !== "number" || !Number.isInteger(field) || field < min)
        throw new Error(`${at}.${key} must be an integer of at least ${min}.`);
      return field;
    };
    const id = text("id")!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`${at}.id may use only letters, digits, - and _.`);
    const workerUrl = text("workerUrl")!;
    if (!URL.canParse(workerUrl)) throw new Error(`${at}.workerUrl is not a URL.`);
    return {
      id,
      sshTarget: text("sshTarget")!,
      workerUrl,
      device: text("device")!,
      precision: text("precision")!,
      rank: integer("rank", Number.MIN_SAFE_INTEGER) ?? index + 1,
      maxConcurrent: integer("maxConcurrent", 1) ?? 1,
      remoteWorkRoot: text("remoteWorkRoot", true) ?? workRoot,
    };
  });
  const ids = hosts.map((host) => host.id);
  if (new Set(ids).size !== ids.length) throw new Error("ALIGNMENT_POOL_HOSTS: host ids must be unique.");
  return hosts;
}

/** Rank order, ties in configuration order. */
function byRank(hosts: PoolHost[]) {
  return hosts.map((host, index) => ({ host, index }))
    .sort((a, b) => a.host.rank - b.host.rank || a.index - b.index)
    .map(({ host }) => host);
}

let depsOverride: PoolSshDeps | null = null;

export function setAlignmentPoolDepsForTests(deps: PoolSshDeps | null) {
  depsOverride = deps;
  resetAlignmentPoolStatusCache();
}

function defaultPoolSshDeps(): PoolSshDeps {
  const exec = async (sshTarget: string, command: string, options: PoolSshOptions = {}) => {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sshTarget, command],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, signal: options.signal },
    );
    return { code: 0, stdout, stderr };
  };
  return {
    exec,
    async uploadFile(localPath, remotePath, sshTarget, options = {}) {
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
        { maxBuffer: 10 * 1024 * 1024, signal: options.signal },
      );
    },
    async probe(sshTarget, options = {}) {
      await exec(sshTarget, "true", options);
      return true;
    },
  };
}

export function poolDeps(): PoolSshDeps {
  if (depsOverride) return depsOverride;
  return defaultPoolSshDeps();
}

function failureDetail(error: unknown) {
  const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : undefined;
  let message = typeof stderr === "string" || Buffer.isBuffer(stderr) ? String(stderr) : "";
  if (!message.trim()) {
    message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown failure";
    if (error instanceof Error && error.cause instanceof Error && error.cause.message)
      message += `: ${error.cause.message}`;
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 200) || "Unknown failure";
}

function formatPoolError(step: string, error: unknown) {
  const detail = failureDetail(error);
  return detail.toLowerCase().startsWith(`${step}:`) ? detail : `${step}: ${detail}`;
}

type PoolDiagnostics = Pick<AlignmentJob, "poolErrors">;

function recordPoolError(job: PoolDiagnostics, hostId: PoolHostId, step: string, error: unknown) {
  job.poolErrors ??= {};
  const formatted = formatPoolError(step, error);
  job.poolErrors[hostId] = formatted;
  getAlignmentPoolCoordinator().recordHostError(hostId, formatted);
}

function clearHostError(job: PoolDiagnostics, hostId: PoolHostId) {
  getAlignmentPoolCoordinator().clearHostError(hostId);
  if (!job.poolErrors) return;
  delete job.poolErrors[hostId];
  if (!Object.keys(job.poolErrors).length) delete job.poolErrors;
}

async function probeHost(job: PoolDiagnostics, host: PoolHost, signal?: AbortSignal) {
  try {
    if (await untilAborted(poolDeps().probe(host.sshTarget, { signal }), signal)) return true;
    recordPoolError(job, host.id, "ssh", "probe failed");
  } catch (error) {
    recordPoolError(job, host.id, "ssh", error);
  }
  return false;
}

type RecordingLease = { jobId: string };

/** Host slots and the one-lease-per-recording rule. Leases are held in this process only. */
export class AlignmentPoolCoordinator {
  private slots = new Map<PoolHostId, Set<string>>();
  private recordings = new Map<string, RecordingLease>();
  private hostErrors = new Map<PoolHostId, string | null>();
  private hosts: PoolHost[];
  constructor(hosts: PoolHost[] = defaultPoolHosts()) {
    this.hosts = byRank(hosts);
  }

  reset() {
    this.slots.clear();
    this.recordings.clear();
    this.hostErrors.clear();
  }

  /** The configured hosts in rank order. */
  listHosts() {
    return [...this.hosts];
  }

  hostById(id: PoolHostId) {
    return this.hosts.find((host) => host.id === id);
  }

  recordHostError(hostId: PoolHostId, reason: string) {
    this.hostErrors.set(hostId, reason);
  }

  clearHostError(hostId: PoolHostId) {
    this.hostErrors.set(hostId, null);
  }

  hasHostErrorState(hostId: PoolHostId) {
    return this.hostErrors.has(hostId);
  }

  lastError(hostId: PoolHostId) {
    return this.hostErrors.get(hostId) ?? null;
  }

  activeOnHost(hostId: PoolHostId) {
    return this.slots.get(hostId)?.size ?? 0;
  }

  hasJobLease(hostId: PoolHostId, jobId: string) {
    return this.slots.get(hostId)?.has(jobId) ?? false;
  }

  // A worker runs up to `capacity` jobs (its reported slots). Reserve a slot across the
  // whole job, including gaps between its individual HTTP requests.
  tryAcquireCtc(hostId: PoolHostId, jobId: string, recordingId: string, capacity = 1) {
    if (this.activeOnHost(hostId) >= capacity) return false;
    const lease = this.recordings.get(recordingId);
    if (lease && lease.jobId !== jobId) return false;
    if (!this.hostById(hostId)) return false;
    const active = this.slots.get(hostId) ?? new Set<string>();
    active.add(jobId);
    this.slots.set(hostId, active);
    this.recordings.set(recordingId, { jobId });
    return true;
  }

  /** Drops every lease a job holds: host slots and its recording. */
  releaseJob(jobId: string) {
    for (const slot of this.slots.values()) slot.delete(jobId);
    for (const [recordingId, lease] of this.recordings)
      if (lease.jobId === jobId) this.recordings.delete(recordingId);
  }

  release(hostId: PoolHostId, jobId: string, recordingId: string) {
    this.slots.get(hostId)?.delete(jobId);
    const lease = this.recordings.get(recordingId);
    if (lease?.jobId === jobId)
      this.recordings.delete(recordingId);
  }

  /**
   * Takes a recording's lease without a host slot (the staging sweep, #421): no job or probe of the recording can
   * take a host while it is held. False when anything holds the recording.
   */
  holdRecording(recordingId: string, holderId: string) {
    if (this.recordings.has(recordingId)) return false;
    this.recordings.set(recordingId, { jobId: holderId });
    return true;
  }

  releaseRecording(recordingId: string, holderId: string) {
    if (this.recordings.get(recordingId)?.jobId === holderId) this.recordings.delete(recordingId);
  }

  recordingHeld(recordingId: string) {
    return this.recordings.has(recordingId);
  }

  /** A host slot or a recording's lease is held under this job or probe id. */
  holdsLease(id: string) {
    for (const slot of this.slots.values()) if (slot.has(id)) return true;
    for (const lease of this.recordings.values()) if (lease.jobId === id) return true;
    return false;
  }
}

/**
 * Stops the server at startup on an invalid `ALIGNMENT_POOL_HOSTS` (malformed, an empty list, a host without a
 * required field, duplicate ids), with the setting and the problem in the message. Unset or empty: the default hosts.
 */
export function checkPoolHostsSetting() {
  try {
    defaultPoolHosts();
  } catch (error) {
    throw new Error(`${(error as Error).message} Fix ALIGNMENT_POOL_HOSTS, or unset it to use the default hosts.`);
  }
}

// Built on first use, so an invalid setting surfaces through checkPoolHostsSetting at startup, not at import.
let coordinator: AlignmentPoolCoordinator | null = null;

export function getAlignmentPoolCoordinator() {
  coordinator ??= new AlignmentPoolCoordinator();
  return coordinator;
}

export function resetAlignmentPoolCoordinator(hosts?: PoolHost[]) {
  coordinator = hosts ? new AlignmentPoolCoordinator(hosts) : null;
  resetAlignmentPoolStatusCache();
}

/** Local test stub: copy into a temp tree instead of SSH. */
export async function stageTracksLocally(
  baseDir: string,
  jobId: string,
  tracks: Track[],
  localAudio: (track: Track) => string | null,
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

/**
 * The assignment a job stores while it has no lease: no current staging, the hosts it tried kept for failover, and
 * the hosts it has staged on kept (for #421).
 */
export function clearPoolStaging(job: AlignmentJob, triedHosts: PoolHostId[]) {
  job.pool = unstagedAssignment(triedHosts, storedStaging(job.pool));
}

/**
 * What a job planned again under its own id (a prepare or rebuild) keeps from `pool`: only the hosts the id has
 * staged on, so the record of its folders survives the new plan (for #421). Undefined when it staged nowhere.
 */
export function keptPoolStaging(pool: AlignmentJobPoolState | undefined): AlignmentJobPoolState | undefined {
  const staged = storedStaging(pool);
  if (!pool || !Object.keys(staged).length) return undefined;
  return { ...unstagedAssignment([], staged), hostId: pool.hostId };
}

/** Every host a stored assignment says the job staged on, and the folder there; older rows name only the current one. */
export function storedStaging(pool: Partial<AlignmentJobPoolState> | null | undefined): Record<PoolHostId, string> {
  const staged: Record<PoolHostId, string> = {};
  const recorded = pool?.stagedHosts;
  if (recorded && typeof recorded === "object")
    for (const [hostId, folder] of Object.entries(recorded)) if (typeof folder === "string" && folder) staged[hostId] = folder;
  if (typeof pool?.hostId === "string" && pool.hostId && typeof pool.jobMediaRoot === "string" && pool.jobMediaRoot)
    staged[pool.hostId] = pool.jobMediaRoot;
  return staged;
}

function unstagedAssignment(triedHosts: PoolHostId[], stagedHosts: Record<PoolHostId, string> = {}): AlignmentJobPoolState {
  return {
    // A placeholder: nothing reads the host of an assignment without staging.
    hostId: getAlignmentPoolCoordinator().listHosts()[0]?.id ?? "",
    attempt: triedHosts.length,
    jobMediaRoot: "",
    workerUrl: "",
    triedHosts,
    stagedAudio: {},
    ...(Object.keys(stagedHosts).length ? { stagedHosts: { ...stagedHosts } } : {}),
  };
}

/** Every host that could take the work is held by other CTC work. */
export class PoolBusyError extends Error {
  /** The hosts the work had staged on (set by its lease), kept with the job while it waits. */
  stagedHosts: Record<PoolHostId, string> = {};
  constructor(readonly triedHosts: PoolHostId[] = []) {
    super("The remote alignment workers are busy.");
  }

  /** What a job stores while it waits in the queue: no current staging, the hosts it tried and staged on kept. */
  get assignment() {
    return unstagedAssignment(this.triedHosts, this.stagedHosts);
  }
}

type CtcHealth = {
  ready: boolean;
  mediaRoot: string;
  busy: boolean;
  stuck: boolean;
  /** Requests the worker runs at once; older workers omit it and run one. */
  slots?: number;
  ctc: { engine: string; ready: boolean; device: string; precision: string; passageReady?: boolean };
};

/** Book jobs a CTC worker takes at once: the slots it reports, 1 for workers that report none. */
export function ctcWorkerSlots(health: { slots?: unknown } | null | undefined) {
  const slots = health?.slots;
  return typeof slots === "number" && Number.isInteger(slots) && slots >= 1 ? Math.min(slots, 16) : 1;
}

function ctcUrlGuardError(host: PoolHost): string | null {
  if (!URL.canParse(host.workerUrl)) return "invalid worker URL";
  // A pool URL pointed at the production machine itself must never send it
  // CTC (ADR 0006), even if something there advertises a compatible CPU runtime.
  const hostname = new URL(host.workerUrl).hostname;
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname))
    return "worker URL points to the local host";
  return null;
}

/**
 * Why a worker's /health body cannot take CTC work for `host`, or null when it can: ready, the pinned CTC engine with
 * its model loaded, the host's configured device and precision, an absolute media root and the busy/stuck state. The
 * deploy's image smoke uses the same rule, so a worker the server would refuse fails the deploy.
 */
export function ctcHealthProblem(host: Pick<PoolHost, "device" | "precision">, value: unknown): string | null {
  const health = value as Partial<CtcHealth> | null | undefined;
  if (!health || typeof health !== "object") return "health is not a JSON object";
  if (health.ready !== true) return "worker is not ready";
  if (typeof health.mediaRoot !== "string" || !isAbsolute(health.mediaRoot)) return "worker reports no absolute media root";
  if (typeof health.busy !== "boolean" || typeof health.stuck !== "boolean") return "worker reports no busy/stuck state";
  if (!health.ctc || health.ctc.engine !== CTC_ENGINE)
    return `worker runs engine ${String(health.ctc?.engine ?? "none")}, expected ${CTC_ENGINE}`;
  if (health.ctc.ready !== true) return "the CTC model is not ready";
  const { device, precision } = host;
  if (health.ctc.device !== device || health.ctc.precision !== precision)
    return `worker runs on ${String(health.ctc.device)}/${String(health.ctc.precision)}, expected ${device}/${precision}`;
  return null;
}

function validCtcHealth(host: PoolHost, health: Partial<CtcHealth> | null | undefined): health is CtcHealth {
  return ctcHealthProblem(host, health) === null;
}

async function ctcHealth(host: PoolHost, signal?: AbortSignal): Promise<CtcHealth> {
  const guardError = ctcUrlGuardError(host);
  if (guardError) throw new Error(guardError);
  const response = await fetch(`${host.workerUrl.replace(/\/$/, "")}/health`, {
    signal: withDeadline(5000, signal),
  });
  if (!response.ok) throw new Error(`worker returned HTTP ${response.status}`);
  const health = await response.json() as CtcHealth;
  if (!validCtcHealth(host, health))
    throw new Error("worker is not ready or has incompatible CTC settings");
  return health;
}

/** The worker's reported media root, for listing what the pool staged there. Throws when it reports none. */
export async function workerMediaRoot(host: PoolHost, signal?: AbortSignal): Promise<string> {
  const guardError = ctcUrlGuardError(host);
  if (guardError) throw new Error(guardError);
  const response = await fetch(`${host.workerUrl.replace(/\/$/, "")}/health`, { signal: withDeadline(5000, signal) });
  if (!response.ok) throw new Error(`worker returned HTTP ${response.status}`);
  const health = await response.json() as { mediaRoot?: unknown } | null;
  if (typeof health?.mediaRoot !== "string" || !isAbsolute(health.mediaRoot))
    throw new Error("worker reports no absolute media root");
  return health.mediaRoot;
}

export const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Where the pool stages the work named `id` inside a worker's media root. */
export function stagingFolder(workerRoot: string, id: string) {
  return join(workerRoot, "alignment", "pool-jobs", id);
}

let retiredStagingName: ((name: string) => boolean) | null = null;

/**
 * Installs the check for folder names the sweep has retired (#421). `alignment-pool-sweep.ts` installs it when it
 * loads; `alignment.ts`, which runs every job and probe, imports that module.
 */
export function setRetiredStagingNameCheck(check: ((name: string) => boolean) | null) {
  retiredStagingName = check;
}

/**
 * The folder name the work `id` stages under now: its id, or the first `<id>.r<n>` the sweep has not retired. Read
 * from the database at staging time, after the host and the recording are leased and before the first remote
 * command, so a name retired before that is never staged into again.
 */
export function stagingName(id: string) {
  if (!retiredStagingName?.(id)) return id;
  for (let n = 1; ; n++) if (!retiredStagingName(`${id}.r${n}`)) return `${id}.r${n}`;
}

/**
 * How long removing a probe's partly staged directory may take after staging failed or aborted. It has its own
 * deadline, never the request's: that signal has usually aborted already, and the staged copy can be the whole
 * recording.
 */
export const PROBE_CLEANUP_TIMEOUT_MS = 30_000;
let probeCleanupTimeoutMs = PROBE_CLEANUP_TIMEOUT_MS;
export function setProbeCleanupTimeoutForTests(ms: number | null) {
  probeCleanupTimeoutMs = ms ?? PROBE_CLEANUP_TIMEOUT_MS;
}

/** Removes a probe's staged directory under its own short deadline. A failure leaves the directory. */
async function removeProbeStaging(host: PoolHost, jobMediaRoot: string, probeId: string) {
  if (!jobMediaRoot.includes(`/alignment/pool-jobs/${probeId}`)) return;
  const cleanup = AbortSignal.timeout(probeCleanupTimeoutMs);
  await untilAborted(
    poolDeps().exec(host.sshTarget, `rm -rf ${shellQuote(jobMediaRoot)}`, { signal: cleanup }), cleanup,
  ).catch(() => undefined);
}

async function stageCtcTracks(
  input: StageTracksInput,
  workerRoot: string,
  { signal, removeOnFailure = false }: { signal?: AbortSignal; removeOnFailure?: boolean } = {},
) {
  // The worker validates outputs against MEDIA_ROOT/alignment. Both the audio
  // and per-job output must therefore be inside its reported root.
  const jobMediaRoot = stagingFolder(workerRoot, input.folderName ?? input.jobId);
  const folder = join(jobMediaRoot, "alignment", input.jobId);
  const deps = poolDeps();
  try {
    await untilAborted(deps.exec(input.host.sshTarget,
      `mkdir -p ${shellQuote(join(jobMediaRoot, "tracks"))} ${shellQuote(folder)}`, { signal }), signal);
    const stagedAudio: Record<string, string> = {};
    for (const track of input.tracks) {
      const local = input.localAudio(track);
      if (!local) continue;
      const remote = join(jobMediaRoot, "tracks", encodeURIComponent(track.id));
      await untilAborted(deps.uploadFile(local, remote, input.host.sshTarget, { signal }), signal);
      stagedAudio[track.id] = remote;
    }
    return { jobMediaRoot, stagedAudio };
  } catch (error) {
    // A probe's directory is its own: remove the partial copy instead of leaving audio on the host.
    if (removeOnFailure) await removeProbeStaging(input.host, jobMediaRoot, input.jobId);
    throw error;
  }
}

/**
 * How a lease ends. "finished": the work has no further use for its staging; for a job that is recorded (its
 * finished status and `pool.stagedHosts`) for the sweep (#421), and nothing is deleted here. "retryable": the next run of the job
 * reuses its staging. A probe's staging is its own and never reused: its release removes it either way.
 */
export type LeaseRelease = "finished" | "retryable";

export type WorkerLeaseRequest = {
  /** The job's id, or a probe's own id: it names the slot and the staging folder on the host. */
  id: string;
  recordingId: string;
  /** Anchored work (every probe, too) needs the worker's passage discovery. */
  mode: AlignmentJob["mode"];
  tracks: Track[];
  localAudio: (track: Track) => string | null;
  /**
   * "job": a queued alignment job. Hosts that are down are not counted as tried, because the job stores its tried
   * hosts and a short outage would exclude that host for good. "probe": hosts that are down stay excluded for the
   * probe's retries, and a probe's partly staged audio is removed when staging fails.
   */
  kind: "job" | "probe";
  /** The job's stored assignment (`job.pool`): its tried hosts are skipped. */
  assignment?: AlignmentJobPoolState;
  /** Hosts already tried by this work; they are skipped. */
  triedHosts?: PoolHostId[];
  /** Receives why each host was skipped (`poolErrors`), also when no host is found. */
  diagnostics?: PoolDiagnostics;
  /** Ends staging (and its SSH/SCP children); no further host is tried. It also bounds a probe's removal in `release`. */
  signal?: AbortSignal;
};

export type WorkerLease = {
  readonly hostId: PoolHostId;
  /** Base address of the leased worker. */
  readonly workerUrl: string;
  /** Folder on the worker (inside its MEDIA_ROOT/alignment) for the work's output files. */
  readonly outputDir: string;
  /** Track id to the staged copy on the host. */
  readonly stagedAudio: Record<string, string>;
  readonly device: string;
  readonly precision: string;
  /** Hosts considered for this work, including the leased one. */
  readonly triedHosts: PoolHostId[];
  /** The assignment a job stores (`job.pool`). */
  readonly assignment: AlignmentJobPoolState;
  /** Why hosts were skipped, by host. */
  readonly poolErrors: AlignmentJob["poolErrors"];
  /** A configured host is left that this work has not tried, and a job has not used its one retry yet. */
  readonly canFailover: boolean;
  /**
   * Frees this host and takes the next untried one, staging the tracks there again; the audio staged here is kept
   * until the release. Throws as `acquireWorkerLease` does; the lease then holds no host.
   */
  failover(): Promise<void>;
  /** Frees the host; a job's staged audio stays, a probe's is removed (see LeaseRelease). Safe to call twice. */
  release(outcome: LeaseRelease): Promise<void>;
};

type HeldHost = AlignmentJobPoolState & { device: string; precision: string };

class PoolWorkerLease implements WorkerLease {
  private held: HeldHost | null = null;
  /** The hosts tried when the lease last lost its host. */
  private lastTried: PoolHostId[];
  /**
   * Every host this work staged on, and the folder there: by this lease, and by the job's earlier runs (its
   * assignment). An entry for a host that is not configured right now is kept, never dropped.
   */
  private staged: Record<PoolHostId, string>;
  /** What a probe lease staged, removed by its release. */
  private probeStaging: { host: PoolHost; jobMediaRoot: string }[] = [];
  private released = false;
  private tried: PoolHostId[];
  readonly diagnostics: PoolDiagnostics;

  constructor(private request: WorkerLeaseRequest) {
    this.diagnostics = request.diagnostics ?? {};
    this.tried = startingTriedHosts(request);
    this.lastTried = [...this.tried];
    this.staged = storedStaging(request.assignment);
  }

  private stagedHosts(): Record<PoolHostId, string> {
    return { ...this.staged };
  }

  private current() {
    if (!this.held) throw new Error("This worker lease holds no host.");
    return this.held;
  }

  get hostId() { return this.current().hostId; }
  get workerUrl() { return this.current().workerUrl; }
  get outputDir() { return join(this.current().jobMediaRoot, "alignment", this.request.id); }
  get stagedAudio() { return this.current().stagedAudio; }
  get device() { return this.current().device; }
  get precision() { return this.current().precision; }
  get triedHosts() { return [...this.tried]; }
  get poolErrors() { return this.diagnostics.poolErrors; }
  get assignment(): AlignmentJobPoolState {
    if (!this.held) return unstagedAssignment([...this.lastTried], this.stagedHosts());
    const { device: _device, precision: _precision, ...state } = this.held;
    return { ...state, triedHosts: [...state.triedHosts], stagedAudio: { ...state.stagedAudio },
      stagedHosts: this.stagedHosts() };
  }
  get canFailover() {
    if (this.request.kind === "job" && this.tried.length >= JOB_HOST_ATTEMPTS) return false;
    return getAlignmentPoolCoordinator().listHosts().some((host) => !this.tried.includes(host.id));
  }

  async take() {
    try {
      this.held = await takeHost(this.request, this.tried, this.diagnostics,
        this.request.kind === "job" ? (hostId, jobMediaRoot) => { this.staged[hostId] = jobMediaRoot; } : undefined);
    } catch (error) {
      if (error instanceof PoolBusyError) error.stagedHosts = this.stagedHosts();
      // No lease is handed out when the first take fails: the hosts staging began on travel with the error.
      else if (error instanceof Error) Object.assign(error, { poolAssignment: this.assignment });
      throw error;
    }
    this.tried = [...this.held.triedHosts];
    this.staged[this.held.hostId] = this.held.jobMediaRoot;
    const host = getAlignmentPoolCoordinator().hostById(this.held.hostId);
    if (this.request.kind === "probe" && host) this.probeStaging.push({ host, jobMediaRoot: this.held.jobMediaRoot });
  }

  async failover() {
    const held = this.current();
    getAlignmentPoolCoordinator().release(held.hostId, this.request.id, this.request.recordingId);
    if (!this.tried.includes(held.hostId)) this.tried.push(held.hostId);
    this.held = null;
    try {
      await this.take();
    } catch (error) {
      if (error instanceof PoolBusyError) this.tried = [...error.triedHosts];
      this.lastTried = [...this.tried];
      throw error;
    }
  }

  async release(_outcome: LeaseRelease) {
    if (this.released) return;
    this.released = true;
    const coord = getAlignmentPoolCoordinator();
    if (this.held) coord.release(this.held.hostId, this.request.id, this.request.recordingId);
    coord.releaseJob(this.request.id);
    this.held = null;
    // A job's staged audio stays on the hosts, whatever the outcome: the sweep removes it (#421), under the
    // recording's lease and after retiring the folder's name. A delete here could outlive the claim and reach a later run.
    if (this.request.kind !== "probe") return;
    // The staged copy is the whole recording; it is this probe's alone, so remove it.
    const signal = this.request.signal;
    await Promise.all(this.probeStaging.map(({ host, jobMediaRoot }) =>
      jobMediaRoot.includes(`/alignment/pool-jobs/${this.request.id}`)
        ? untilAborted(
          poolDeps().exec(host.sshTarget, `rm -rf ${shellQuote(jobMediaRoot)}`, { signal }), signal,
        ).catch(() => undefined)
        : undefined));
  }
}

/** A job's tried hosts: those of its stored assignment, unless that names a host no longer in the pool. */
function startingTriedHosts(request: WorkerLeaseRequest): PoolHostId[] {
  const coord = getAlignmentPoolCoordinator();
  const stored = request.assignment;
  // A stored staging on a host that left the pool (the Steam Deck, #279) starts a fresh pair of attempts.
  const fromAssignment = stored?.jobMediaRoot && !coord.hostById(stored.hostId) ? [] : stored?.triedHosts ?? [];
  const tried = [...fromAssignment, ...(request.triedHosts ?? [])];
  return [...new Set(tried)].filter((id) => !!coord.hostById(id));
}

/** Takes the first healthy untried host with a free slot and stages the tracks on it. */
async function takeHost(
  request: WorkerLeaseRequest, triedHosts: PoolHostId[], diagnostics: PoolDiagnostics,
  onStaging?: (hostId: PoolHostId, jobMediaRoot: string) => void,
): Promise<HeldHost> {
  const coord = getAlignmentPoolCoordinator();
  const probe = request.kind === "probe";
  const signal = request.signal;
  const attempted = [...triedHosts];
  const exclude = (id: PoolHostId) => { if (probe) attempted.push(id); };
  let busy = false;
  const roundOver = () => !probe && attempted.length >= JOB_HOST_ATTEMPTS;
  for (const host of coord.listHosts()) {
    signal?.throwIfAborted();
    if (roundOver()) break;
    const id = host.id;
    if (attempted.includes(id)) continue;
    let health: CtcHealth;
    try {
      health = await ctcHealth(host, signal);
    } catch (error) {
      recordPoolError(diagnostics, id, "health", error);
      // Unreachable / unhealthy hosts stay excluded for this acquire (and a probe's retries).
      exclude(id);
      continue;
    }
    if (request.mode === "anchored" && health.ctc.passageReady !== true) {
      recordPoolError(diagnostics, id, "health", "passage discovery is not ready");
      exclude(id);
      continue;
    }
    const capacity = ctcWorkerSlots(health);
    // A stuck request keeps its slot, so a worker with every slot taken reports busy.
    if (health.busy || (capacity === 1 && health.stuck) || coord.activeOnHost(id) >= capacity) {
      recordPoolError(diagnostics, id, "health", health.stuck && capacity === 1 ? "worker is stuck" : "worker is busy");
      busy = true;
      continue;
    }
    if (!(await probeHost(diagnostics, host, signal))) {
      exclude(id);
      continue;
    }
    if (!coord.tryAcquireCtc(id, request.id, request.recordingId, capacity)) {
      recordPoolError(diagnostics, id, "capacity", "worker or recording is busy");
      busy = true;
      continue;
    }
    try {
      // Chosen now, under the host and recording leases: a name the sweep retired is never used again (#421).
      const folderName = stagingName(request.id);
      // Recorded before the first byte is sent: an upload that fails half way still leaves audio on the host.
      onStaging?.(id, stagingFolder(health.mediaRoot, folderName));
      const staged = await stageCtcTracks(
        { jobId: request.id, folderName, host, tracks: request.tracks, localAudio: request.localAudio },
        health.mediaRoot, { signal, removeOnFailure: probe });
      clearHostError(diagnostics, id);
      return { hostId: id, attempt: attempted.length + 1, ...staged, workerUrl: host.workerUrl,
        triedHosts: [...attempted, id], device: health.ctc.device, precision: health.ctc.precision };
    } catch (error) {
      coord.release(id, request.id, request.recordingId);
      if (signal?.aborted) throw signal.reason;
      recordPoolError(diagnostics, id, "staging", error);
      attempted.push(id);
    }
  }
  signal?.throwIfAborted();
  if (busy && !roundOver()) throw new PoolBusyError(attempted);
  throw new Error(POOL_FAILURE_MESSAGE);
}

/**
 * Leases a pool host for `request`: the first healthy host in rank order, not yet tried, with a free slot, and
 * the tracks staged on it. Throws PoolBusyError when every host that could take the work is held by other CTC
 * work, and an Error (POOL_FAILURE_MESSAGE) when none can take it. A lease holds the worker's slot and the
 * recording, so a probe never overlaps a queued alignment on the same host or recording. The caller releases it
 * on every exit.
 */
export async function acquireWorkerLease(request: WorkerLeaseRequest): Promise<WorkerLease> {
  // The job runner checks the pool itself, with a message of its own.
  if (request.kind === "probe" && !poolEnabled()) throw new Error("CTC alignment requires the remote pool.");
  const lease = new PoolWorkerLease(request);
  await lease.take();
  return lease;
}

export function poolFailureMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return POOL_FAILURE_MESSAGE;
}

export function currentPoolEngine(): "ctc" {
  return "ctc";
}

export function activePoolHosts(
  hosts: PoolHost[] = getAlignmentPoolCoordinator().listHosts(),
) {
  return byRank(hosts);
}

function safeWorkerUrl(raw: string) {
  if (!URL.canParse(raw)) return raw.replace(/\/\/[^/@]*@/, "//");
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

type ProbedHostSnapshot = {
  id: PoolHostId;
  sshTarget: string;
  workerUrl: string;
  maxConcurrent: number;
  reachable: boolean;
  device: string | null;
  precision: string | null;
  workerBusy: boolean;
  stuck: boolean;
  probeError: string | null;
};

type CachedPoolProbe = {
  key: string;
  enabled: boolean;
  engine: "ctc";
  checkedAt: number;
  hosts: ProbedHostSnapshot[];
};

const poolStatusTtlMs = 30_000;
let cachedPoolProbe: CachedPoolProbe | null = null;
let pendingPoolProbe: { key: string; promise: Promise<CachedPoolProbe> } | null = null;

export function resetAlignmentPoolStatusCache() {
  cachedPoolProbe = null;
  pendingPoolProbe = null;
}

function poolProbeCacheKey() {
  const engine = currentPoolEngine();
  const hosts = activePoolHosts(getAlignmentPoolCoordinator().listHosts())
    .map((host) => `${host.id}:${host.sshTarget}:${host.workerUrl}:${host.maxConcurrent}`)
    .join("|");
  return `${poolEnabled() ? "1" : "0"}\n${engine}\n${hosts}`;
}

async function probeSinglePoolHost(host: PoolHost): Promise<ProbedHostSnapshot> {
  let maxConcurrent = 1;
  const workerUrl = safeWorkerUrl(host.workerUrl);
  const guardError = ctcUrlGuardError(host);
  if (guardError) {
    return {
      id: host.id,
      sshTarget: host.sshTarget,
      workerUrl,
      maxConcurrent,
      reachable: false,
      device: null,
      precision: null,
      workerBusy: false,
      stuck: false,
      probeError: formatPoolError("health", guardError),
    };
  }
  let device: string | null = null;
  let precision: string | null = null;
  let workerBusy = false;
  let stuck = false;
  let healthError: string | null = null;
  let sshError: string | null = null;
  await Promise.all([
    (async () => {
      try {
        const response = await fetch(`${host.workerUrl.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          healthError = `health: worker returned HTTP ${response.status}`;
          return;
        }
        const raw = await response.json() as Partial<CtcHealth> | null;
        if (raw && typeof raw === "object") {
          workerBusy = raw.busy === true;
          stuck = raw.stuck === true;
          maxConcurrent = ctcWorkerSlots(raw);
          if (typeof raw.ctc?.device === "string") device = raw.ctc.device;
          if (typeof raw.ctc?.precision === "string") precision = raw.ctc.precision;
        }
        if (!validCtcHealth(host, raw))
          healthError = "health: worker is not ready or has incompatible CTC settings";
      } catch (error) {
        healthError = formatPoolError("health", error);
      }
    })(),
    (async () => {
      try {
        if (!(await poolDeps().probe(host.sshTarget))) sshError = "ssh: probe failed";
      } catch (error) {
        sshError = formatPoolError("ssh", error);
      }
    })(),
  ]);
  const probeError = healthError ?? sshError;
  return {
    id: host.id,
    sshTarget: host.sshTarget,
    workerUrl,
    maxConcurrent,
    reachable: probeError === null,
    device,
    precision,
    workerBusy,
    stuck,
    probeError,
  };
}

async function runPoolProbe(): Promise<CachedPoolProbe> {
  const enabled = poolEnabled();
  const engine = currentPoolEngine();
  const hosts = activePoolHosts(getAlignmentPoolCoordinator().listHosts());
  const checkedAt = Date.now();
  const key = poolProbeCacheKey();
  if (!enabled) {
    return {
      key,
      enabled: false,
      engine,
      checkedAt,
      hosts: hosts.map((host) => ({
        id: host.id,
        sshTarget: host.sshTarget,
        workerUrl: safeWorkerUrl(host.workerUrl),
        maxConcurrent: 1,
        reachable: false,
        device: null,
        precision: null,
        workerBusy: false,
        stuck: false,
        probeError: null,
      })),
    };
  }
  const probed = await Promise.all(hosts.map((host) => probeSinglePoolHost(host)));
  return {
    key,
    enabled: true,
    engine,
    checkedAt: Date.now(),
    hosts: probed,
  };
}

function materializePoolStatus(
  snapshot: CachedPoolProbe,
  persistedErrors?: Partial<Record<PoolHostId, string>>,
): AlignmentPoolStatus {
  const coord = getAlignmentPoolCoordinator();
  return {
    enabled: snapshot.enabled,
    engine: snapshot.engine,
    checkedAt: snapshot.checkedAt,
    hosts: snapshot.hosts.map((host): AlignmentPoolHostStatus => {
      const activeJobs = coord.activeOnHost(host.id);
      const busy = host.workerBusy || host.stuck || activeJobs > 0;
      const lastError =
        host.probeError ??
        (host.stuck ? coord.lastError(host.id) ?? "health: worker is stuck" : null) ??
        (coord.hasHostErrorState(host.id) ? coord.lastError(host.id) : persistedErrors?.[host.id] ?? null);
      return {
        id: host.id,
        sshTarget: host.sshTarget,
        workerUrl: host.workerUrl,
        reachable: host.reachable,
        device: host.device,
        precision: host.precision,
        busy,
        stuck: host.stuck,
        activeJobs,
        maxConcurrent: host.maxConcurrent,
        lastError,
      };
    }),
  };
}

export async function probeAlignmentPool(
  persistedErrors?: Partial<Record<PoolHostId, string>>,
): Promise<AlignmentPoolStatus> {
  const snapshot = await runPoolProbe();
  if (poolProbeCacheKey() === snapshot.key) cachedPoolProbe = snapshot;
  return materializePoolStatus(snapshot, persistedErrors);
}

export async function getAlignmentPoolStatus(options?: {
  fresh?: boolean;
  persistedErrors?: Partial<Record<PoolHostId, string>>;
}): Promise<AlignmentPoolStatus> {
  if (options?.fresh || !poolEnabled()) return probeAlignmentPool(options?.persistedErrors);
  const key = poolProbeCacheKey();
  if (cachedPoolProbe?.key === key && Date.now() - cachedPoolProbe.checkedAt < poolStatusTtlMs) {
    return materializePoolStatus(cachedPoolProbe, options?.persistedErrors);
  }
  if (pendingPoolProbe?.key === key) {
    return materializePoolStatus(await pendingPoolProbe.promise, options?.persistedErrors);
  }
  const promise = runPoolProbe()
    .then((snapshot) => {
      if (poolProbeCacheKey() === snapshot.key) cachedPoolProbe = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (pendingPoolProbe?.promise === promise) pendingPoolProbe = null;
    });
  pendingPoolProbe = { key, promise };
  return materializePoolStatus(await promise, options?.persistedErrors);
}

export { POOL_FAILURE_MESSAGE };
