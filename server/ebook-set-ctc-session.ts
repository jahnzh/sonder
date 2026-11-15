// One recording's CTC probing session: takes a worker lease (the first healthy pool host in rank order, with the
// audio staged on it) and scores a run's candidates on it. Every request carries the recording's cache identity, so five
// candidates cost about one acoustic pass.
import { isPaused } from "./activity-pause.ts";
import { audioFingerprint, recordingContext, trackLocalAudioPath } from "./alignment.ts";
import { randomUUID } from "node:crypto";
import {
  acquireWorkerLease,
  PoolBusyError,
  type PoolHostId,
  type WorkerLease,
} from "./alignment-pool.ts";
import {
  ProbeLanguageNotSupported,
  scoreCtcSamples,
  type AnchorSampleScore,
} from "./ebook-set-ctc-probe.ts";

/** How long a probe waits for a pool host held by other CTC work before the candidate stays held. */
export const PROBE_HOST_WAIT_MS = 5 * 60 * 1000;
const PROBE_RETRY_MS = 5000;

export type ProbeSample = { trackId: string; time: number; duration: number };

export type ProbeSession = {
  score(input: { fragmentTexts: string[]; language: string; samples: ProbeSample[] }): Promise<AnchorSampleScore[]>;
  /**
   * Frees the pool host and removes the staged audio. The session stays usable: the next `score` leases again.
   */
  release(): Promise<void>;
};

/** The pool could not run the probe now; the candidate stays held and is probed again on the next evaluation. */
export class ProbeUnavailable extends Error {}

export function createCtcProbeSession(
  recordingId: string,
  /** `signal` ends staging, scoring and cleanup (and their child processes) when the caller's deadline passes. */
  options: { waitMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): ProbeSession {
  const signal = options.signal;
  const waitMs = options.waitMs ?? PROBE_HOST_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lease: WorkerLease | null = null;
  // Latch only when no pool host can be acquired for this run (MEDIUM-3); a per-candidate score failure must not
  // skip the rest of the session.
  let unavailable: ProbeUnavailable | null = null;

  async function acquire(trackIds: Set<string>, tried: PoolHostId[]) {
    if (isPaused("alignment")) {
      const error = new ProbeUnavailable("Alignment is paused.");
      unavailable = error;
      throw error;
    }
    const { tracks } = recordingContext(recordingId);
    const needed = tracks.filter((track) => trackIds.has(track.id));
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        // Each lease stages under its own id, so a probe never shares a folder with a job or another probe.
        const next = await acquireWorkerLease({ id: `ctc-probe-${randomUUID()}`, recordingId, mode: "anchored",
          tracks: needed, localAudio: trackLocalAudioPath, kind: "probe", triedHosts: tried, signal });
        lease = next;
        // Hosts dispatch already tried (including the one that succeeded) stay excluded on a later retry.
        for (const host of next.triedHosts) if (!tried.includes(host)) tried.push(host);
        return next;
      } catch (error) {
        if (error instanceof PoolBusyError && Date.now() < deadline && !signal?.aborted) {
          await sleep(PROBE_RETRY_MS);
          continue;
        }
        const refusal = new ProbeUnavailable(error instanceof Error ? error.message : String(error));
        // Only latch when the initial acquire fails; a per-candidate failover retry must not skip later candidates.
        if (tried.length === 0) unavailable = refusal;
        throw refusal;
      }
    }
  }

  async function release() {
    const held = lease;
    lease = null;
    // A probe's staged copy is its own and never reused: always remove it.
    await held?.release("finished");
  }

  async function run(fragmentTexts: string[], language: string, samples: ProbeSample[]) {
    const trackIds = new Set(samples.map((sample) => sample.trackId));
    const fingerprint = audioFingerprint(recordingId);
    const token = process.env.ALIGNMENT_WORKER_TOKEN;
    if (!token) throw new ProbeUnavailable("The alignment worker is not configured.");
    // tried / retried are per candidate so one score failure does not permanently skip later candidates.
    const tried: PoolHostId[] = [];
    let retried = false;
    for (;;) {
      const active = lease ?? (await acquire(trackIds, tried));
      // A reused lease still carries hosts already excluded for this recording staging.
      for (const host of active.triedHosts) if (!tried.includes(host)) tried.push(host);
      const windows = samples.map((sample) => ({ ...sample, audio: active.stagedAudio[sample.trackId] }));
      if (windows.some((window) => !window.audio)) throw new ProbeUnavailable("The recording audio could not be staged.");
      try {
        return await scoreCtcSamples(
          {
            workerUrl: active.workerUrl.replace(/\/$/, ""),
            token,
            outputDir: active.outputDir,
            recordingId,
            audioFingerprint: fingerprint,
            signal,
          },
          { fragmentTexts, language, windows },
        );
      } catch (error) {
        if (error instanceof ProbeLanguageNotSupported) throw error;
        // Past the caller's deadline nothing is retried; the lease is freed and the error goes up.
        if (signal?.aborted) {
          await release();
          throw error;
        }
        // A failed probe retries once on the next host (ADR 0005), then this candidate stays held.
        if (!tried.includes(active.hostId)) tried.push(active.hostId);
        const hostLeft = active.canFailover;
        await release();
        if (retried || !hostLeft)
          throw new ProbeUnavailable(error instanceof Error ? error.message : String(error));
        retried = true;
      }
    }
  }

  return {
    async score({ fragmentTexts, language, samples }) {
      if (unavailable) throw unavailable;
      return await run(fragmentTexts, language, samples);
    },
    release,
  };
}
