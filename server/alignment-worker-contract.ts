// Worker HTTP response shapes shared by the alignment queue and the ebook-set probe. Imports nothing from the database.
import { z } from "zod";

export const workerMetadata = z.object({
  engine: z.string().min(1).optional(),
  outcome: z.enum(["mapped", "partial", "unsynced", "language_not_supported", "error"]).optional(),
  stageTimings: z.record(z.string(), z.number().nonnegative().finite()).optional(),
  /** Mean GPU utilization percent for the request; null on CPU-only hosts. */
  gpuUtilization: z.number().min(0).max(100).finite().nullable().optional(),
  /** Microbatch, OOM halvings and worker pools the request ran with (#276); older workers omit it. */
  runConfig: z.object({
    acousticMicrobatch: z.number().int().positive().optional(),
    acousticMicrobatchUsed: z.number().int().positive().optional(),
    oomHalvings: z.number().int().nonnegative().optional(),
    decodeWorkers: z.number().int().nonnegative().optional(),
    extractWorkers: z.number().int().nonnegative().optional(),
    residentModelsPerDevice: z.number().int().positive().optional(),
  }).optional(),
});
export type WorkerMetadata = z.infer<typeof workerMetadata>;
export const anchorResult = z.object({
  ...workerMetadata.shape,
  match: z
    .object({ index: z.number().int().nonnegative(), lastIndex: z.number().int().nonnegative().optional(), score: z.number().min(0).max(1).finite() })
    .nullable(),
  start: z.number().nonnegative().finite().optional(),
  matches: z.array(z.object({
    index: z.number().int().nonnegative(),
    lastIndex: z.number().int().nonnegative().optional(),
    score: z.number().min(0).max(1).finite(),
    start: z.number().nonnegative().finite(),
  })).max(8).optional(),
  text: z.string().optional(),
});
export type AnchorResult = z.infer<typeof anchorResult>;
