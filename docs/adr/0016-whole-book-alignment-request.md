# One whole-book request across the alignment worker seam

The server hands the alignment worker a whole book (the ebook's sentences, the staged tracks and the recording's identity) and receives an **alignment map** with its unsynced passages and extra-audio flags. Sampling, anchor selection, segment planning, stitching and chunking move behind the worker's interface; the server's two runner loops and the window endpoints (`/align`, `/anchor-batch`) go away once every map has been rebuilt. The model stays Wav2Vec2 Base (ADR 0006). The aligner changes, so this is a new engine generation and every existing map is rebuilt.

The request is a job on the worker: the server starts it, reads its progress, can cancel it, and fetches the result. The worker decodes each track once, encodes the whole recording in one continuous pass, and aligns in groups. Groups are the unit of progress and of resume: emissions are cached per track and finished groups are kept, so a restart of the server or the worker continues instead of starting over.

The aligner is built on a global anchor chain, not on forward-only recovery. It locates the text throughout the recording, keeps the longest chain of locations that rises in both audio and text, and keeps each recovery jump inside its group. Around it:

- a **text-match check** before any alignment, which turns a wrong book or a wrong language into an explicit outcome instead of an empty map;
- a **leftover pass** that locates unmapped audio against unmapped sections, for recordings whose chapters run in a different order from the ebook;
- decoding on the **container's timeline** (timestamps, not sample counts);
- parallel decoding of a single-file recording by time range.

Everything the worker holds for a book while it is aligned belongs to one per-book session keyed by the job: the decoded audio, the digests, the acoustic cache handle and the locate pool, under one lock order and one disk budget for decoded audio and emissions together. The session ends when the result has been fetched or the job is cancelled, and after 15 idle minutes if the server never comes back.

One encode runs on a GPU at a time; a worker queues the others. Decoding and aligning of other books run beside it, and ebook-set probes reuse the session's cached emissions.

Lisa stays the fallback with the same model and the same request, used when WSL cannot be reached, so maps from both hosts remain one generation. A whole book on its CPU takes hours (about 4.85 times real time); that is accepted for a fallback.

## Evidence

Measured on 12 recordings and 19 ebook pairings on the WSL GPU (2026-11-14, reports `PROTO-D-E.md` and `PROTO-D-E-BOOKS.md`, issue #389):

- Encode at 1,178 to 1,208 times real time and 91 to 96 % mean GPU on every book; a 33 h book in about 3 minutes end to end against 10 to 14 today.
- With the anchor chain, 99.71 to 99.98 % agreement with production's maps on the eight pairings whose ebook matches the recording's chapter order, and the 128-utterance labelled gate unchanged (maximum 194.3 ms).
- The first prototype's forward-only recovery lost its place for good on 2 of 9 matching recordings (a narrated introduction that quotes the novel). That is why the chain is part of the decision.
- Two recordings that production left empty are mapped and cross-checked against another edition's map (*Consider Phlebas*, *The Picture of Dorian Gray*). Two deliberately wrong pairings map at most one sentence.
- Open limits found: a recording with reordered chapters reaches 69 % agreement without the leftover pass; one single-file M4A drifts 1.2 s when timed by sample count.

## Considered options

- **Keep the window endpoints and tune them.** The server and the worker must then keep agreeing on the limits, the cache identity and the output paths, and a book still takes hundreds of round trips.
- **Switch to the first prototype as measured.** Refused: two complete failures on common input.

## Consequences

- **Qualification before production switches.** All of: the labelled gate through the real worker interface; the probing gate of #278; on every pairing of the 2026-11-14 set whose ebook matches, agreement of at least 99.5 % and a mapped share no more than 2 points below production's; the same on at least five further recordings that were not used while designing the chain; the reordered recording mapped at least as far as production maps it.
- **The rebuild is guarded.** A rebuilt map that is empty or much worse than the kept one does not replace it (#379), so a book the new aligner handles worse keeps its old map.
- Worker and server are built and deployed separately. The worker keeps the window endpoints until no deployed server calls them.
- The per-book session (#391) is the worker half of this and is built with it. The server-side timeout of #398 disappears with `/anchor-batch`. Chapter pairing (#348) is not needed by a whole-book pass.
- Server tests use a fake worker that answers one request; they stop rebuilding `/health` by hand.
- Issues: #389, #391.
