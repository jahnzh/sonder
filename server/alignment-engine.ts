/** The pinned CTC alignment engine: the identity every pool worker must run and every CTC map records. */
export const CTC_ENGINE = "ctc-wav2vec2-base-960h-torchaudio-2.8-v2";
/**
 * The whole-book engine generation (ADR 0016; book-v2 since #403): the same model through the worker's `/book-jobs`. A map the
 * whole-book runner publishes records the engine the worker's result names, which must be this one. Defined in
 * `src/reading-types.ts`, which the Reading sync card reads too.
 */
export { BOOK_ENGINE } from "../src/reading-types.ts";

/**
 * `ALIGNMENT_BOOK_JOBS=1` runs every full alignment as one whole-book job on the worker (#404); off by default,
 * so production keeps the window runner until the whole-book engine has qualified. Read here only.
 */
export function bookJobsEnabled() {
  return process.env.ALIGNMENT_BOOK_JOBS === "1";
}
