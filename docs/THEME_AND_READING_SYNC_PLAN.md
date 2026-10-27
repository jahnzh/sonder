# Theme customization and ebook/audio synchronization

Planning date: 26 October 2026. The local EPUB/theme implementation is now delivered; see [implementation measurements and remaining limits](ALIGNMENT_BENCHMARK.md). Hosted processing remains optional and disabled. The original design and acceptance targets are preserved below.

## Decisions and current state

- Keep Sonder mobile first and dark by default, with substantially more appearance controls.
- Build the reader inside Sonder first, as requested. External reader adapters can follow later.
- Prefer local processing. Because the ebook text is available, benchmark **known-text forced alignment before full transcription**. Use short transcription excerpts to locate uncertain sections; use full transcription only where that improves reliability.
- The current host has a four-core Intel N150, approximately 16 GB RAM, Intel integrated graphics and no detected NVIDIA GPU. CPU processing is the baseline; no GPU performance is assumed. A real sample benchmark is needed before quoting elapsed processing time.
- Audio progress is already recording/track specific. Ebooks already have separate edition IDs and work links, but the ebook progress table is only a foundation: there is no integrated reader or text/audio alignment map yet.
- The existing Hardcover percentage/page conversion remains useful for overall progress, but it does not locate sentences in an ebook.

## 1. Theme customization

### Foundation

Replace the current combination of hardcoded colors and later dark-theme overrides with semantic design tokens. Cover backgrounds, raised surfaces, text, muted text, borders, accent and accent text, focus, selection, status colors, overlays and the player. Make typography and spacing use scalable tokens as well. Change every affected component, including source results, settings, dialogs and the persistent player; changing root colors alone would leave inconsistent surfaces.

Keep book covers and illustrations in their original colors. Theme changes must not remount the player, interrupt playback, reset the reader or change a reading position.

### User controls

Add Settings → Appearance with immediate preview, reset and a saved preference:

- Presets: current Forest, neutral Charcoal, AMOLED black, high contrast and Light. Dark remains the default; optional System follows the device preference.
- Accent palette and a custom accent color, with a readable foreground chosen automatically.
- An advanced palette editor for page/surface colors, primary/secondary text and borders, with contrast feedback and a one-click reset.
- Interface font choice, overall text size and comfortable/compact spacing, with minimum touch targets preserved.
- Reader preferences independent of the app: dark/light/sepia page, font family, text size, line height, margins, line width and paginated/scroll mode.
- Versioned JSON preset import/export. Import validated preferences, rather than arbitrary CSS.

Persist account defaults on the server and allow device overrides. Cache preferences locally and apply the cached theme before React renders, avoiding a flash of the wrong theme. Theme the PWA browser chrome as well as the page.

### Acceptance

Verify all presets on narrow phones and desktop, offline reload, preference synchronization and large text. Check normal text contrast against the 4.5:1 WCAG minimum, visible focus and controls that do not depend on color alone. Changing theme, font or viewport must preserve the current playback and EPUB location. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

## 2. Built-in reader and synchronized positions

### Reader foundation

Implement EPUB first, including table of contents, search, bookmarks, font controls and offline download. Prototype EPUB.js behind a small reader adapter: its documented CFI, relocation, theme and DOM-range APIs cover the basic requirements. Pin the dependency and validate mobile Safari/Chromium, resource loading and ebook content isolation before adopting it. Do not allow ebook scripts to run with the app’s privileges. [EPUB.js APIs](https://github.com/futurepress/epub.js/blob/master/documentation/md/API.md)

Store positions using an EPUB CFI plus spine resource and text offsets/quote context. Page numbers are display information; changing font size or screen dimensions must not change the saved location. Extract normalized text with a reversible mapping to the original EPUB DOM, so alignment offsets resolve back to the original book.

PDF download remains available. Text-based PDF reading/alignment, and scanned PDFs requiring OCR, are later phases with their own locator model. They are not included in the first EPUB synchronization milestone.

### Why the existing text helps

Transcription asks what words were spoken. Forced alignment instead takes supplied words and finds their times in the audio. Tools already support this directly: aeneas produces a synchronization map from text fragments and narration, while CTC forced aligners take audio plus text and output timing spans. Neither requires us to generate a complete free-form transcript first. [aeneas](https://github.com/readbeyond/aeneas), [CTC forced aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner)

This reduces the unknowns, but it is not a guarantee of faster execution with every model. Audio still needs acoustic analysis. Large omissions, added introductions, repeated passages, different editions, translations or dramatizations can make supplied text an imperfect transcript. Align by bounded sections and detect failures rather than forcing a timestamp onto every paragraph. aeneas explicitly documents the need for matching audio/text and warns that large unmatched portions can produce incorrect maps. [aeneas limitations](https://github.com/readbeyond/aeneas#limitations-and-missing-features)

Two directions have different costs:

- **Audio → ebook:** the playback time is known. A short local transcription around that point can be searched against the ebook, without transcribing the whole recording.
- **Ebook → audio:** the text location is known but the audio time is not. Reliable seeking needs an existing map, chapter boundaries, or a search/indexing step. Approximate whole-book percentage alone is not precise enough.

### Local alignment pipeline

1. Pair an exact EPUB edition with an exact audiobook recording. Offer language, narrator and release information. Reject a clear language mismatch, such as an English ebook and French narration.
   Check for existing compatible EPUB media-overlay timings or a cached map before scheduling new analysis; reuse them only when they match the exact recording.
2. Ensure the audio is stored locally using Sonder’s existing HDD-copy/download flow. Alignment must not depend on an expiring TorBox URL or change how ordinary streaming works.
3. Extract EPUB text in reading order, retaining DOM offsets. Read real track durations and embedded chapter metadata. Match chapter headings where possible, allowing for different chapter boundaries between formats.
4. Benchmark an aeneas-style CPU sentence/paragraph aligner against a CTC aligner on representative chapters. Measure both resource use and recovery from introductions, silence and omitted text. Include fantasy names and one deliberately incompatible pair. Choose the engine on measured quality and speed, not a GPU benchmark from another machine. Check maintenance, model availability and distribution terms during this spike.
5. Prefer chapter/section processing with overlapping boundaries. If a boundary or match is uncertain, transcribe a short excerpt locally with a small whisper.cpp model, find that passage in the ebook, and use it as an anchor. Process more audio only when the uncertainty requires it. whisper.cpp documents CPU operation and optional Intel acceleration; acceleration remains an experiment on this host. [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
6. Save sentence or paragraph intervals, confidence, unmatched regions and manual corrections. Sentence-level switching is the first goal; word-by-word highlighting is optional later work.
7. Cache the result once per EPUB/recording pair. A new narration requires its own map. A changed EPUB can reuse an unchanged audio analysis but needs a new text map. Validate maps against source fingerprints, track order/durations, normalization version and engine version.

Storyteller is a useful reference for handling edition differences and matching text to audio. During the spike, evaluate whether its processing components or API can be reused without introducing a second user-facing library. Its documented pipeline uses transcription followed by text matching; that is an alternative/fallback rather than the assumed first path for this app. [Storyteller algorithm](https://storyteller-platform.dev/docs/the-algorithm/)

### Storage and background work

Run processing in a separate restartable worker so the API and player stay responsive. Start with one job, limited CPU use and a memory cap validated by the sample benchmark. Pause, cancel, retry and resume at completed section boundaries.

Keep models, temporary audio, analysis and maps under `/mnt/usb_4t_1/sonder/alignment/`, with the same mounted-volume checks as the existing media storage. Keep job metadata in SQLite. Read original files without modifying them, and publish completed maps atomically. Avoid decoding an entire long audiobook into memory at once.

Proposed durable records:

- Alignment jobs: pair, status, section, engine, source fingerprints, progress and last error.
- Alignment maps: ebook edition, recording, map version, coverage and storage path.
- Map intervals: EPUB resource/offsets, track ID, start/end seconds, confidence and unmatched gaps.
- Reading checkpoints: edition/recording pair, text locator, optional audio locator, origin, event ID, device and server revision.

### Reader/player behavior and progress

- Make the workflow available directly from the expanded media player: device Save/Pause/Resume, a link to the current book’s ebook editions, **Prepare reading sync** with job status, and **Read from listening position** once a map is ready. The reader provides the matching **Listen from here** action and appearance controls. Preserve the active recording and playback position when moving between these views.
- Preserve the playback source indicator in the compact and expanded player and the reader’s audio controls: TorBox, host-server file, or device cache. Derive it from actual delivery, including offline service-worker responses and server copies of TorBox files.
- Show **Prepare reading sync**, then Queued/Processing/Ready/Partial/Needs a different edition with a useful explanation.
- **Read from listening position** opens the corresponding sentence. **Listen from here** seeks to the matching part of the selected recording.
- Optional follow-along highlights the current passage while audio continues. Turning follow-along off permits independent browsing.
- Auto-follow relocation events do not count as new reading progress and must not create sync loops.
- Preserve each recording’s native progress. Switching to another narration must use that narration’s map, never the previous release’s raw timestamp.
- Use revisions and idempotent events for cross-device/offline reconciliation. Reading backward or seeking backward is legitimate; do not simply keep the largest percentage. Preserve both checkpoints when a concurrent offline conflict cannot be resolved safely.
- Cache ebook content and the map for offline use alongside the existing optional audio downloads. Cached maps do not require any online inference during playback or reading.
- Publish overall status/progress to Hardcover. Precise text/audio locators stay in Sonder; a coarse incoming Hardcover percentage must not silently replace a newer, more precise checkpoint.
- Low-confidence regions offer a chapter fallback or a manual anchor. Label them as approximate instead of pretending they are sentence accurate.

### Acceptance

For a compatible unabridged test pair, target switching within one sentence at at least 95% of manually checked checkpoints, including near chapter/file boundaries. Treat this as an acceptance target, not a measured result.

Also verify font/viewport changes, refresh, offline reopening, worker restart, source replacement, wrong-language refusal, omitted introductions, two narrations of the same work, backward reading and conflicting device updates. An incompatible edition should produce a useful partial result or refusal, rather than a plausible-looking wrong map.

## Optional hosted fallback and costs

Prices checked 26 October 2026, in USD. These are baseline **audio transcription** charges, not a promise that the provider will directly map an EPUB. Text matching, confidence checks and position persistence remain part of Sonder.

| Processing option | Per audio hour | 10-hour book | 20-hour book | 40-hour book |
| --- | ---: | ---: | ---: | ---: |
| Local known-text alignment | $0 API fee | $0 API fee | $0 API fee | $0 API fee |
| AssemblyAI Universal-2 | $0.15 | $1.50 | $3.00 | $6.00 |
| AssemblyAI Universal-3.5 Pro | $0.21 | $2.10 | $4.20 | $8.40 |
| Deepgram Nova-3 monolingual | $0.258 | $2.58 | $5.16 | $10.32 |
| OpenAI gpt-transcribe | $0.27 | $2.70 | $5.40 | $10.80 |

AssemblyAI lists word-level timestamps in its prerecorded transcription product and the rates above. Deepgram charges $0.0043/minute for Nova-3 monolingual and exposes timed words. OpenAI lists gpt-transcribe at $0.0045/minute. [AssemblyAI pricing](https://www.assemblyai.com/pricing), [Deepgram pricing](https://deepgram.com/pricing), [Deepgram timed-word response](https://developers.deepgram.com/docs/utterances/), [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

Local processing still uses electricity, storage and server time; it has no per-book API bill. Hosted figures exclude tax, retries, overlapping chunks, optional features and any additional alignment compute. Use mono prerecorded transcription without speaker diarization or other paid extras by default.

Do not assume all transcription models return word timestamps. For a new OpenAI integration, validate the current gpt-transcribe output and allow a local timestamp-alignment stage; the documented legacy Whisper timestamp interface is deprecated and scheduled to shut down on 26 February 2027. [Official OpenAI transcription documentation](https://developers.openai.com/api/docs/guides/speech-to-text)

Recommended fallback: compare AssemblyAI Universal-2/Universal-3.5 Pro and Deepgram on the same difficult sample. Prefer a provider that returns usable timings, not just the cheapest transcript. Keep hosted processing off by default, show the estimated charge before submission, support a per-book/monthly limit, and store keys encrypted. Upload audio only for explicitly enabled jobs.

Pay only for unresolved sections when possible. At 10% of a 20-hour book, baseline transcription would be approximately $0.30–$0.54, excluding provider rounding/minimums and retries. Reuse successful analysis: listening or reading the prepared book again should not generate another API charge.

## Delivery order

1. **Theme foundation and Appearance settings:** token conversion, presets, scalable typography, persistence and regression checks.
2. **Built-in EPUB reader:** reading locators, reader appearance, offline storage and checkpoint APIs.
3. **Local feasibility spike:** benchmark known-text alignment and short-clip anchor recovery on this N150, with published sample accuracy, RAM and elapsed-time results. Use those measurements to estimate a full book.
4. **End-to-end synchronization:** durable maps/jobs, per-release pairing, reader/player switches, confidence handling, offline reconciliation and Hardcover integration.
5. **Optional hosted processing:** provider adapter, cost preview, spending limits and an explicit opt-in. Add only if local results or processing times warrant it.
6. **Later extensions:** word highlighting, text PDFs/OCR and external-reader plugins/APIs.

The first implementation milestone should deliver customizable appearance plus a working built-in EPUB reader. The alignment spike is the decision point before committing to a specific processing engine or any hosted spending.
