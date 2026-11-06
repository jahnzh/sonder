import { Worker } from "node:worker_threads";
import { consensusCellCount, type ConsensusRow, type MemberSentence } from "./ebook-set-aligner.ts";

import { CONSENSUS_MAX_CELLS } from "./ebook-set-consensus-limits.ts";
export const CONSENSUS_MAX_OLD_GENERATION_MB = 1536;
export const CONSENSUS_TIMEOUT_MS = 10 * 60 * 1000;

export class ConsensusSupersededError extends Error {
  constructor() { super("Consensus build was superseded by a newer request."); }
}

type Pending = { workId: string; lists: MemberSentence[][]; resolve: (rows: ConsensusRow[]) => void; reject: (error: Error) => void };
const pending = new Map<string, Pending>();
let busy = false;

export function cancelPendingConsensus(workId: string) {
  const previous = pending.get(workId);
  if (previous) { pending.delete(workId); previous.reject(new ConsensusSupersededError()); }
}

export function runConsensusBuild(workId: string, lists: MemberSentence[][]): Promise<ConsensusRow[]> {
  // Every progressive result contains at least the longest input.
  let maxRows = lists[0]?.length ?? 0;
  for (const list of lists.slice(1)) {
    if (consensusCellCount(maxRows, list.length) > CONSENSUS_MAX_CELLS)
      return Promise.reject(new Error("These editions are too long to compare automatically. Try fewer or shorter editions."));
    maxRows = Math.max(maxRows, list.length);
  }
  cancelPendingConsensus(workId);
  return new Promise((resolve, reject) => {
    pending.set(workId, { workId, lists, resolve, reject });
    pump();
  });
}

/** Runs and releases one worker, including error and deadline paths. */
export function executeConsensusWorker(
  lists: MemberSentence[][],
  options: { timeoutMs?: number; createWorker?: () => Worker } = {},
): Promise<ConsensusRow[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = options.createWorker?.() ?? new Worker(new URL("./ebook-set-consensus-worker.ts", import.meta.url), {
        workerData: lists,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: CONSENSUS_MAX_OLD_GENERATION_MB },
      });
    } catch (error) { reject(error); return; }
    let settled = false;
    const finish = async (error?: Error, rows?: ConsensusRow[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { await worker.terminate(); }
      catch (terminationError) { error ??= terminationError as Error; }
      if (error) reject(error); else resolve(rows!);
    };
    const timer = setTimeout(() => { void finish(new Error("Consensus comparison timed out after 10 minutes. Try fewer or shorter editions.")); }, options.timeoutMs ?? CONSENSUS_TIMEOUT_MS);
    worker.once("message", (rows: ConsensusRow[]) => { void finish(undefined, rows); });
    worker.once("error", error => { void finish(error); });
    worker.once("exit", code => { void finish(new Error(`Consensus worker exited before producing a result (code ${code}).`)); });
  });
}

function pump() {
  if (busy || !pending.size) return;
  const item = pending.values().next().value!;
  pending.delete(item.workId);
  busy = true;
  void executeConsensusWorker(item.lists).then(item.resolve, item.reject).finally(() => {
    busy = false;
    pump();
  });
}
