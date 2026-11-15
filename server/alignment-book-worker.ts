// The worker's whole-book interface (#402, docs/CTC_WORKER_POOL.md "Whole-book jobs"): start, progress, cancel and
// result of one job, and the shapes the server reads from them. HTTP only; nothing here touches the database.
import { z } from "zod";

/** A whole-book job's states on the worker; `done`, `failed` and `cancelled` end it. */
export const BOOK_STATES = ["queued", "decoding", "encoding", "anchoring", "aligning", "finishing", "done", "failed", "cancelled"] as const;

export type BookStartRequest = {
  jobId: string;
  recordingId: string;
  audioFingerprint?: string;
  language: string;
  sentences: { id: string; section: number; text: string }[];
  tracks: { id: string; audio: string; duration: number }[];
};

const count = z.number().int().nonnegative().finite();
export const bookProgress = z.object({
  jobId: z.string(),
  engine: z.string().optional(),
  // A state this server does not know yet counts as running.
  state: z.string(),
  progress: z.object({
    tracksTotal: count.optional(),
    tracksDecoded: count.optional(),
    tracksEncoded: count.optional(),
    groupsTotal: count.optional(),
    groupsDone: count.optional(),
  }).passthrough().nullable().optional(),
  stageTimings: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  resumed: count.optional(),
}).passthrough();
export type BookProgress = z.infer<typeof bookProgress>;

/** The result on main (#402). #403 adds the text-match outcome, unsynced passages and extra-audio flags. */
export const bookResult = z.object({
  jobId: z.string(),
  engine: z.string(),
  outcome: z.string(),
  intervals: z.array(z.object({
    paragraphId: z.string(),
    section: z.number().int().nonnegative().optional(),
    trackId: z.string(),
    start: z.number().nonnegative().finite(),
    end: z.number().nonnegative().finite(),
    confidence: z.number().min(0).max(1).finite(),
  })),
  stageTimings: z.record(z.string(), z.unknown()).nullable().optional(),
  encode: z.object({ gpuUtilization: z.number().min(0).max(100).finite().nullable().optional() }).passthrough().nullable().optional(),
}).passthrough();
export type BookResult = z.infer<typeof bookResult>;

/**
 * How the worker answered: `ok` with its body; `unknown` (404, no such job); `unavailable` (no answer, a 503 while
 * it resumes after a restart, another server error, or a successful answer whose body could not be read as JSON:
 * cut after its headers or malformed); `conflict` (409); `refused` (any other 4xx, and 507).
 */
export type BookAnswer =
  | { kind: "ok"; body: unknown }
  | { kind: "unknown" }
  | { kind: "unavailable"; reason: string }
  | { kind: "conflict"; reason: string }
  | { kind: "refused"; status: number; reason: string };

/** Per request: a start sends up to 32 MiB, a cancel waits up to about 40 s for the job to stop, a result can be large. */
const TIMEOUT_MS = { start: 120_000, status: 30_000, cancel: 90_000, result: 300_000 };
let timeouts = { ...TIMEOUT_MS };
/** Tests: shorter bounds for some requests (a cancel the worker never answers); null restores them. */
export function setBookWorkerTimeoutsForTests(next: Partial<typeof TIMEOUT_MS> | null) {
  timeouts = { ...TIMEOUT_MS, ...next };
}

async function detail(response: Response) {
  const text = await response.text().catch((error: unknown) => `(no body: ${(error as Error).message})`);
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown };
    const value = body?.detail ?? body?.message;
    if (typeof value === "string") return value;
    if (value !== undefined) return JSON.stringify(value).slice(0, 300);
  } catch (error) {
    // Not JSON: the text itself is the reason.
    if (!(error instanceof SyntaxError)) throw error;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

async function call(
  workerUrl: string, method: "GET" | "POST" | "DELETE", path: string, timeoutMs: number, body?: BookStartRequest,
): Promise<BookAnswer> {
  let response: Response;
  try {
    response = await fetch(`${workerUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.ALIGNMENT_WORKER_TOKEN ?? ""}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return { kind: "unavailable", reason: `${error instanceof Error ? error.message : String(error)}${cause}` };
  }
  if (response.ok) {
    try {
      return { kind: "ok", body: await response.json() };
    } catch (error) {
      // The headers said yes, the body is cut or not JSON: no answer from this host, under the same bound.
      return { kind: "unavailable", reason: `HTTP ${response.status} with a body that could not be read: ${(error as Error).message}` };
    }
  }
  const reason = `HTTP ${response.status}: ${await detail(response)}`;
  if (response.status === 404) return { kind: "unknown" };
  if (response.status === 409) return { kind: "conflict", reason };
  if (response.status >= 500 && response.status !== 507) return { kind: "unavailable", reason };
  return { kind: "refused", status: response.status, reason };
}

const jobPath = (jobId: string) => `/book-jobs/${encodeURIComponent(jobId)}`;

export const bookWorker = {
  start: (workerUrl: string, request: BookStartRequest) => call(workerUrl, "POST", "/book-jobs", timeouts.start, request),
  status: (workerUrl: string, jobId: string) => call(workerUrl, "GET", jobPath(jobId), timeouts.status),
  cancel: (workerUrl: string, jobId: string) => call(workerUrl, "DELETE", jobPath(jobId), timeouts.cancel),
  result: (workerUrl: string, jobId: string) => call(workerUrl, "GET", `${jobPath(jobId)}/result`, timeouts.result),
};
