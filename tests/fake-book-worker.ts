// An in-process fake of the pool workers' whole-book interface (#402, docs/CTC_WORKER_POOL.md "Whole-book jobs"):
// one real HTTP server per host on 127.0.0.2, so the server's own `fetch` talks to it and nothing is swapped. It
// answers `/health` (with `bookJobs`), the four `/book-jobs` requests, and `/anchor` and `/align` for probes and the
// window runner. SSH staging comes from `fake-pool-host.ts` (each host's directory stands in for its MEDIA_ROOT).
// Switches per host: slow progress, a stage a job waits at, a job that fails, a restart that answers 503 and then
// resumes (or forgets its jobs, so 404), a host that is down, a worker without whole-book jobs; a cancel held open
// or failing, a start whose reply is lost, a status or result answered with an error, a body cut after its headers
// or not JSON. Every upload into a file a job on the host reads is recorded.
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { BOOK_ENGINE, CTC_ENGINE } from "../server/alignment-engine.ts";
import type { PoolHost, PoolSshDeps } from "../server/alignment-pool.ts";
import { alignAnswer, fakePoolHosts, type FakeHostState } from "./fake-pool-host.ts";

/** A job's stages on the worker, in order; it can also end `failed`. */
export const BOOK_STAGES = ["queued", "decoding", "encoding", "anchoring", "aligning", "finishing", "done"] as const;
export type BookStage = (typeof BOOK_STAGES)[number];

export type FakeBookJob = {
  jobId: string;
  request: any;
  /** The request as JSON: the same id with another request is 409. */
  identity: string;
  step: number;
  polls: number;
  failed: string | null;
  failAt: FakeBookHost["failAt"];
  resumed: number;
  createdAt: number;
  updatedAt: number;
  stageTimings: Record<string, number>;
};

export type FakeBookHost = FakeHostState & {
  /** Every whole-book request this host answered or refused, as "METHOD path". */
  book: string[];
  /** The bodies of the start requests it received. */
  starts: any[];
  jobs: Map<string, FakeBookJob>;
  /** Status polls a job spends in each stage before it moves on: raise it for slow progress. */
  pollsPerStage: number;
  /** Jobs do not move past this stage while it is set. */
  holdAt: BookStage | null;
  /** Jobs started while it is set fail when they reach `stage`, with `error`. */
  failAt: { stage: BookStage; error: string } | null;
  /** The next n whole-book requests answer 503, as a restarted worker does while it picks up its retained jobs. */
  resuming: number;
  /** `/health` reports no `bookJobs`, as a worker from before #402. */
  noBookJobs: boolean;
  /** The share of the sentences the result maps (the first ones), 1 by default. */
  mapShare: number;
  /** The engine the result names: the whole-book engine by default. */
  resultEngine: string;
  /** Runs before a whole-book request is answered. */
  onBook?: (method: string, path: string) => void | Promise<void>;
  /** Every whole-book request this host sent an answer to (or cut or dropped), as "METHOD path", in order. */
  answered: string[];
  /** A cancel (DELETE) waits for this before it answers; the job keeps running until then, as a worker's does. */
  holdCancel: Promise<void> | null;
  /** The next n cancels answer 503 and leave the job running. */
  cancelFails: number;
  /** The next n starts create (or find) the job and then drop the connection: the reply is lost. */
  loseStartReplies: number;
  /** Status polls answer this HTTP status while it is set (the job is not advanced). */
  statusAnswer: number | null;
  /** Result fetches answer this HTTP status while it is set; the job keeps its result. */
  resultAnswer: number | null;
  /** The next n status polls (or result fetches) send their headers and a part of the body, then cut the connection. */
  cutStatus: number;
  cutResult: number;
  /** The next n status polls answer 200 with a body that is not JSON. */
  garbleStatus: number;
  /** The next n status polls answer 200 with JSON that is not a progress answer. */
  misshapeStatus: number;
  /** Every upload's remote path, in order. */
  uploads: string[];
  /** Uploads into a file that a job on this host (running, or cancelled and not stopped yet) reads. */
  uploadsIntoLiveJobs: string[];
};

export type FakeBookPool = {
  hosts: Record<string, FakeBookHost>;
  /** The fake SSH for `setAlignmentPoolDepsForTests`. */
  deps: PoolSshDeps;
  /** The pool configuration for `resetAlignmentPoolCoordinator`, in this order of rank. */
  poolHosts(ids?: string[]): PoolHost[];
  stagedFolders(hostId: string): string[];
  /** The worker restarts: book requests answer 503 `resumingFor` times; it keeps its jobs unless `keepJobs` is false. */
  restart(hostId: string, options?: { keepJobs?: boolean; resumingFor?: number }): void;
  close(): Promise<void>;
};

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Seconds each stage adds to `stageTimings` as a job passes it. */
const STAGE_SECONDS: Record<string, [string, number]> = {
  queued: ["identity", 0.4], decoding: ["decode", 1.5], encoding: ["encode", 2], anchoring: ["anchor", 0.5],
  aligning: ["align", 3], finishing: ["finish", 0.1],
};

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** The headers and the first bytes of the body, then the connection is cut: the reader fails after the headers. */
function cut(response: ServerResponse, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) });
  response.write(text.slice(0, 8), () => setTimeout(() => response.socket?.destroy(), 5));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function state(job: FakeBookJob) {
  return job.failed !== null ? "failed" : BOOK_STAGES[job.step];
}

/** The worker's progress answer (docs/CTC_WORKER_POOL.md "Progress"). */
function progress(job: FakeBookJob) {
  const tracks = job.request.tracks.length;
  const passed = (stage: BookStage) => job.step > BOOK_STAGES.indexOf(stage);
  return {
    jobId: job.jobId, engine: BOOK_ENGINE, state: state(job), recordingId: job.request.recordingId,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    progress: {
      tracksTotal: tracks, tracksDecoded: passed("decoding") ? tracks : 0, tracksEncoded: passed("encoding") ? tracks : 0,
      ...(job.step >= BOOK_STAGES.indexOf("aligning") ? { groupsTotal: 2, groupsDone: passed("aligning") ? 2 : 0 } : {}),
      ...(BOOK_STAGES[job.step] === "encoding" ? { encodeQueuePosition: 0 } : {}),
    },
    stageTimings: { ...job.stageTimings }, error: job.failed, resumed: job.resumed,
  };
}

/** The worker's result (docs/CTC_WORKER_POOL.md "Result"), shaped as on main (#402). */
function result(host: FakeBookHost, job: FakeBookJob) {
  const { request } = job;
  const encode = { encodeSeconds: 2, audioSeconds: 400, realtime: 200, batch: 8, oomHalvings: 0,
    gpuUtilization: host.device === "cuda" ? 93 : null };
  if (request.language !== "eng")
    return { jobId: job.jobId, engine: BOOK_ENGINE, outcome: "language_not_supported", intervals: [], tracks: [],
      stageTimings: job.stageTimings, encode: null };
  const mapped = request.sentences.slice(0, Math.ceil(request.sentences.length * host.mapShare));
  return {
    jobId: job.jobId, engine: host.resultEngine, recordingId: request.recordingId, audioFingerprint: request.audioFingerprint,
    outcome: mapped.length ? "mapped" : "unsynced", sentences: request.sentences.length, mapped: mapped.length,
    intervals: mapped.map((sentence: any, index: number) => ({
      paragraphId: sentence.id, section: sentence.section, trackId: request.tracks[0].id,
      start: index * 2, end: index * 2 + 1.5, confidence: 0.65,
    })),
    tracks: request.tracks.map((track: any) => ({ id: track.id, decodedSeconds: track.duration,
      containerSeconds: track.duration, differenceSeconds: 0, durationOk: true, ranges: 1 })),
    stats: { groups: 2, groupStartsSeconds: [0, 200], windows: 0, kernel: "numpy", device: host.device },
    stageTimings: job.stageTimings, encode,
  };
}

/** One status poll: the job moves to its next stage after `pollsPerStage` polls, unless held or failed. */
function advance(host: FakeBookHost, job: FakeBookJob) {
  if (job.failed !== null || BOOK_STAGES[job.step] === "done") return;
  if (++job.polls < host.pollsPerStage || host.holdAt === BOOK_STAGES[job.step]) return;
  const [timing, seconds] = STAGE_SECONDS[BOOK_STAGES[job.step]];
  job.stageTimings[timing] = (job.stageTimings[timing] ?? 0) + seconds;
  job.step++;
  job.polls = 0;
  job.updatedAt = Date.now() / 1000;
  if (job.failAt?.stage === BOOK_STAGES[job.step]) job.failed = job.failAt.error;
}

async function answerBook(host: FakeBookHost, method: string, path: string, raw: string, authorization: string | undefined, response: ServerResponse) {
  host.book.push(`${method} ${path}`);
  await host.onBook?.(method, path);
  await answerBookRequest(host, method, path, raw, authorization, response);
  host.answered.push(`${method} ${path}`);
}

async function answerBookRequest(host: FakeBookHost, method: string, path: string, raw: string, authorization: string | undefined, response: ServerResponse) {
  if (authorization !== `Bearer ${process.env.ALIGNMENT_WORKER_TOKEN}`)
    return send(response, 401, { detail: "Worker authentication required." });
  if (host.resuming > 0) {
    host.resuming--;
    return send(response, 503, { detail: "The worker is still picking up its retained book jobs. Retry shortly." });
  }
  if (method === "POST" && path === "/book-jobs") {
    const request = JSON.parse(raw);
    host.starts.push(request);
    if (!JOB_ID.test(request.jobId ?? "") || !request.sentences?.length || !request.tracks?.length ||
        request.tracks.some((track: any) => !(track.duration > 0)))
      return send(response, 422, { detail: [{ type: "value_error", loc: ["body"], msg: "invalid start request" }] });
    for (const track of request.tracks)
      if (!resolve(String(track.audio)).startsWith(`${host.root}/`) || !existsSync(track.audio))
        return send(response, 400, { detail: "The audio must be on the configured media drive." });
    const identity = JSON.stringify(request);
    const existing = host.jobs.get(request.jobId);
    if (existing && existing.identity !== identity) return send(response, 409, { detail: "This job id already holds another request." });
    const now = Date.now() / 1000;
    const job: FakeBookJob = existing ?? { jobId: request.jobId, request, identity, step: 0, polls: 0, failed: null,
      failAt: host.failAt, resumed: 0, createdAt: now, updatedAt: now, stageTimings: {} };
    host.jobs.set(job.jobId, job);
    if (host.loseStartReplies > 0) {
      // The worker has the job; the server never hears so.
      host.loseStartReplies--;
      response.socket?.destroy();
      return;
    }
    return send(response, 202, progress(job));
  }
  const match = /^\/book-jobs\/([^/]+)(\/result)?$/.exec(path);
  const job = match && host.jobs.get(decodeURIComponent(match[1]));
  if (!match || !job) return send(response, 404, { detail: match ? "Unknown book job." : "Not Found" });
  if (method === "DELETE" && !match[2]) {
    // The worker answers once the job's processes have stopped; until then the job still reads its files.
    if (host.holdCancel) await host.holdCancel;
    if (host.cancelFails > 0) {
      host.cancelFails--;
      return send(response, 503, { detail: "The worker could not stop the job." });
    }
    host.jobs.delete(job.jobId);
    return send(response, 200, { jobId: job.jobId, engine: BOOK_ENGINE, state: "cancelled" });
  }
  if (method === "GET" && match[2]) {
    if (host.resultAnswer !== null) return send(response, host.resultAnswer, { detail: "The result could not be read." });
    if (state(job) !== "done")
      return send(response, 409, { jobId: job.jobId, engine: BOOK_ENGINE, state: state(job), message: "The job has not finished." });
    // The fetch ends the job.
    host.jobs.delete(job.jobId);
    if (host.cutResult > 0) {
      host.cutResult--;
      return cut(response, result(host, job));
    }
    return send(response, 200, result(host, job));
  }
  if (method === "GET") {
    if (host.statusAnswer !== null) return send(response, host.statusAnswer, { detail: "The worker cannot answer." });
    advance(host, job);
    if (host.cutStatus > 0) {
      host.cutStatus--;
      return cut(response, progress(job));
    }
    if (host.garbleStatus > 0) {
      host.garbleStatus--;
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end("{\"jobId\": ");
    }
    if (host.misshapeStatus > 0) {
      host.misshapeStatus--;
      return send(response, 200, { jobId: job.jobId, state: 7 });
    }
    return send(response, 200, progress(job));
  }
  return send(response, 405, { detail: "Method Not Allowed" });
}

function health(host: FakeBookHost) {
  return {
    ready: true, engine: CTC_ENGINE, busy: host.busy, stuck: false, busySeconds: null, lastTimeout: null,
    slots: host.slots ?? 1, activeRequests: 0, mediaRoot: host.root,
    ctc: { engine: CTC_ENGINE, ready: true, device: host.device, precision: host.precision,
      anchorReady: true, passageReady: true, anchorBatch: true },
    ...(host.noBookJobs ? {} : {
      bookJobs: { engine: BOOK_ENGINE, ready: true, jobs: host.jobs.size, resuming: host.resuming > 0, slotsHeld: 0,
        batchSeconds: null, stuck: [], diskReservedBytes: 0, diskBudgetBytes: 64 * 1024 ** 3 },
    }),
  };
}

export async function fakeBookWorkers(
  temp: string,
  specs: { id: string; device: string; precision: string }[] = [
    { id: "wsl", device: "cuda", precision: "float16" },
    { id: "lisa", device: "cpu", precision: "float32" },
  ],
): Promise<FakeBookPool> {
  const ssh = fakePoolHosts(temp, specs);
  const hosts: Record<string, FakeBookHost> = {};
  const servers: Server[] = [];
  for (const spec of specs) {
    const host = Object.assign(ssh.hosts[spec.id], {
      book: [], starts: [], jobs: new Map(), pollsPerStage: 1, holdAt: null, failAt: null, resuming: 0,
      noBookJobs: false, mapShare: 1, resultEngine: BOOK_ENGINE, answered: [], holdCancel: null, cancelFails: 0,
      loseStartReplies: 0, statusAnswer: null, resultAnswer: null, cutStatus: 0, cutResult: 0, garbleStatus: 0, misshapeStatus: 0,
      uploads: [], uploadsIntoLiveJobs: [],
    }) as FakeBookHost;
    hosts[spec.id] = host;
    const server = createServer((request, response) => {
      // Down: the connection is dropped, as by a host that is off or a worker that is restarting.
      if (host.down) return request.socket.destroy();
      void (async () => {
        const url = new URL(request.url ?? "/", "http://worker");
        const raw = await readBody(request);
        if (url.pathname === "/health") return send(response, 200, health(host));
        if (url.pathname.startsWith("/book-jobs"))
          return answerBook(host, request.method ?? "GET", url.pathname, raw, request.headers.authorization, response);
        host.requests.push(url.pathname);
        const body = JSON.parse(raw || "{}");
        if (body.token !== process.env.ALIGNMENT_WORKER_TOKEN) return send(response, 401, { detail: "Worker authentication required." });
        if (url.pathname === "/anchor") {
          if (!String(body.audio).startsWith(`${host.root}/`) || !existsSync(body.audio))
            return send(response, 500, { detail: "audio is not staged on this host" });
          return send(response, 200, { engine: CTC_ENGINE, outcome: "mapped", match: { index: 0, score: 0.9 },
            start: body.start, text: "First sentence. Another sentence." });
        }
        const reply = await alignAnswer(host, url.pathname, body);
        if (reply instanceof Response) return send(response, reply.status, { detail: await reply.text() });
        return send(response, 200, reply);
      })().catch((error: unknown) => send(response, 500, { detail: String(error) }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.2", done));
    host.workerUrl = `http://127.0.0.2:${(server.address() as AddressInfo).port}`;
    servers.push(server);
  }
  const deps: PoolSshDeps = {
    ...ssh.deps,
    async uploadFile(local, remote, target, options) {
      const host = Object.values(hosts).find((candidate) => candidate.sshTarget === target);
      if (host) {
        host.uploads.push(remote);
        if ([...host.jobs.values()].some((job) => job.request.tracks.some((track: any) => track.audio === remote)))
          host.uploadsIntoLiveJobs.push(remote);
      }
      return ssh.deps.uploadFile(local, remote, target, options);
    },
  };
  return {
    hosts,
    deps,
    poolHosts: (ids = Object.keys(hosts)) => ids.map((id, index) => {
      const host = hosts[id];
      return { id, sshTarget: host.sshTarget, workerUrl: host.workerUrl, device: host.device, precision: host.precision,
        rank: index + 1, maxConcurrent: 1, remoteWorkRoot: host.root };
    }),
    stagedFolders: ssh.stagedFolders,
    restart(hostId, { keepJobs = true, resumingFor = 2 } = {}) {
      const host = hosts[hostId];
      if (!keepJobs) host.jobs.clear();
      for (const job of host.jobs.values()) job.resumed++;
      host.resuming = resumingFor;
    },
    async close() {
      await Promise.all(servers.map((server) => new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      })));
    },
  };
}
