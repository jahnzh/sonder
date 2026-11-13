// One recording's CTC probing session: leases a pool host (WSL GPU first, lisa CPU as the fallback), stages the
// audio once, and scores every candidate's samples on it, so five candidates cost about one acoustic pass.
import { isPaused } from "./activity-pause.ts";
import { audioFingerprint, recordingContext, trackLocalAudioPath } from "./alignment.ts";
import {
  acquireCtcProbeLease,
  PoolBusyError,
  type CtcProbeLease,
  type PoolHostId,
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
  close(): Promise<void>;
};

/** The pool could not run the probe now; the candidate stays held and is probed again on the next evaluation. */
export class ProbeUnavailable extends Error {}

export function createCtcProbeSession(
  recordingId: string,
  options: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): ProbeSession {
  const waitMs = options.waitMs ?? PROBE_HOST_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lease: CtcProbeLease | null = null;
  const tried: PoolHostId[] = [];
  let retried = false;

  async function acquire(trackIds: Set<string>) {
    if (isPaused("alignment")) throw new ProbeUnavailable("Alignment is paused.");
    const { tracks } = recordingContext(recordingId);
    const needed = tracks.filter((track) => trackIds.has(track.id));
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const next = await acquireCtcProbeLease(recordingId, needed, trackLocalAudioPath, tried);
        lease = next;
        return next;
      } catch (error) {
        if (error instanceof PoolBusyError && Date.now() < deadline) {
          await sleep(PROBE_RETRY_MS);
          continue;
        }
        throw new ProbeUnavailable(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function release() {
    const held = lease;
    lease = null;
    await held?.release();
  }

  return {
    async score({ fragmentTexts, language, samples }) {
      const trackIds = new Set(samples.map((sample) => sample.trackId));
      const fingerprint = audioFingerprint(recordingId);
      const token = process.env.ALIGNMENT_WORKER_TOKEN;
      if (!token) throw new ProbeUnavailable("The alignment worker is not configured.");
      for (;;) {
        const active = lease ?? (await acquire(trackIds));
        const windows = samples.map((sample) => ({
          ...sample,
          audio: active.stagedAudio[sample.trackId],
        }));
        if (windows.some((window) => !window.audio)) throw new ProbeUnavailable("The recording audio could not be staged.");
        try {
          return await scoreCtcSamples(
            {
              workerUrl: active.workerUrl.replace(/\/$/, ""),
              token,
              outputDir: active.outputDir,
              recordingId,
              audioFingerprint: fingerprint,
            },
            { fragmentTexts, language, windows },
          );
        } catch (error) {
          if (error instanceof ProbeLanguageNotSupported) throw error;
          // A failed probe retries once on the other host (ADR 0005), then the candidate stays held.
          tried.push(active.hostId);
          await release();
          if (retried) throw new ProbeUnavailable(error instanceof Error ? error.message : String(error));
          retried = true;
        }
      }
    },
    close: release,
  };
}
