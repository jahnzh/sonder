# Handoff: single-file-sync (issue #5)

> **Historical note.** This records one working session on 2026-10-27 and is not current instructions. Sonder is live at https://sonder.pecori.no (Caddy → 127.0.0.1:3001); see `README.md` for the current setup.

Branch `single-file-sync`. Commits: `ac621f4` (the coordinator's PLAYWRIGHT_PORT cherry-pick of 1e0847a) and `201db27` (the feature).

## Done
- `server/alignment-anchors.ts` (new, pure): sample planning, anchor selection (score-weighted LIS plus rejection of anchors displaced in opposite directions), speaking rate, midpoint refinement for mismatched windows, window planning with overlapping text/audio, intro/outro/skipped-text/extra-audio/unaligned flags, and core-interval filtering and stitching.
- `server/alignment.ts`: an anchored job mode (`mode: "anchored"`, `anchoring` state on AlignmentJob). It is used automatically for releases with no chapter markers when nothing is matched, and a single chapterless file no longer gets an auto title pairing. Samples and windows go one request at a time and persist after each step, so a job can pause, resume or rebuild. Too few matches refuses the EPUB as a different edition. The chapter-paired path's output is unchanged. POST /api/alignments accepts an optional `mode`, and older request shapes still work.
- **No worker change.** It uses only the existing `/anchor` and `/align` endpoints, so the production sonder-alignment container does not need a rebuild.
- UI (`ReadingSync.tsx`): Prepare is enabled for chapterless releases, with sampling/window progress and a flags list. Choosing chapters manually still uses the chapter workflow.
- README reading-sync section updated.

## Tests
- `npm run build`: passes.
- `npm test`: 86/86 pass. New: `tests/alignment-anchors.test.ts` (6 synthetic tests) and one integration test in `tests/reader.test.ts` covering pause/resume without repeating samples, intro/outro flags, timing accuracy, edition refusal, and refusal of anchored mode for a chaptered release.
- `PLAYWRIGHT_PORT=4177 npm run test:browser`: 28/28 pass, including the new `tests/e2e/chapterless-sync.spec.ts`.

## Real-media dry run (interrupted by the HALT)
- Setup: a separate worker container on :3013 from the same `sonder-alignment:local` image, a throwaway DB and media root in the scratchpad, and models mounted read-only. The production DB was only opened read-only. The container is now removed.
- The truly chapterless DCC release (Unknown narrator, torbox-128519954) is **not on the HDD**, so it was not tested. Instead I used the Jeff Hays DCC MP3 (48,693 s) with its chapters ignored, and compared against its existing chapter-paired map.
- Sampling: 88 samples, 86 anchors, 0 refinements, rate 2.66 words/s, ~6 min. Planned 85 windows. Flags: outro 13:28:44–13:31:33 only (no intro flagged).
- Alignment stopped after 5 of 85 windows (340 sentences). Against the chapter map: median start difference 0.005 s, p95 0.065 s, max 1.69 s, 98.5% within 1 s, 100% within 3 s. **Coverage % for the whole book was not measured** because the run was halted.

## Next steps
1. Rerun the dry run to completion (~10–15 min of alignment): scratchpad script `dryrun.mts`, or reproduce it from the description above.
2. To test the real chapterless release, it needs saving to the HDD ("Save to server"). That writes to production, so it needs the user's OK.
3. The mismatch thresholds (ratio 0.75 / 1.3, plus 45 s slack) are tuned on synthetic data. Check them on a release with real skipped text or extra audio.
4. Not verified on the user's phone or in the live UI against real media.
