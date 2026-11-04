# Evaluate ebook candidates in parallel on SSH hosts

Automatic ebook matching evaluates candidates in parallel and offloads evaluation tasks over SSH to lisa, steamdeck and WSL. This chooses shorter comparison turnaround and distributed compute over a single serial evaluation queue; it requires remote execution and file transfer because the current alignment worker uses paths on the application host's media storage. Staging, per-host caps and failure handling are set in the amendment below.

## Amendment: probe and project before parallel alignment

Aligning several EPUB candidates fully against one audio is N times the compute, and only one result is kept; running them in parallel on the single local worker only splits its two CPUs. Evaluation therefore proceeds in stages:

1. Transcribe the audio samples once and probe every candidate with the existing anchor-sample step.
2. Align the candidates to the ebook set as text, drop gross outliers and project the consensus map onto the rest (see ADR 0004, amendment). Rank by sentences shared with the set and audio-supported.
3. Run a full audio alignment only for a new recording, or when the set changes enough to need the consensus re-aligned to the audio. Only these jobs are dispatched over SSH to lisa, steamdeck and WSL, in parallel when there are several.

The remote pool is smaller in scope than first decided: it is for new recordings and unprojectable candidates, not for every candidate. The k candidates downloaded for a title are probed and text-aligned locally.

## Amendment: staging, host caps and failure handling

- **Staging.** Every SSH or parallel full-alignment job gets its own work directory under a dedicated `MEDIA_ROOT`. Models may be shared read-only; audio is staged so resolved paths stay on that root. Jobs must not share one `alignment/` temp tree.
- **Per-host concurrency (initial caps).** WSL ≤ 3; steamdeck ≤ 1; lisa ≤ 3 only after an alignment env like WSL’s is installed (v1 ships WSL + steamdeck only). The local N150 `sonder-alignment` worker ≤ 1 and never in parallel with a remote job for the same recording. Caps are overrides later, not sacred.
- **Failure.** A failed or unreachable remote full alignment retries once on another pool host, then stays failed/retryable in the UI. No silent half-finished local fallback. Probe and projection results already held are kept.

## Prototype note: parallel isolation (Dungeon Crawler Carl series)

Running up to three full windowed alignments at once on WSL (16 cores, `nice -n 10`) worked for eight volumes under the staging rule above. Sharing one `alignment/` temp directory across jobs corrupted WAV samples; symlinked audio outside `MEDIA_ROOT` was rejected by the worker.
