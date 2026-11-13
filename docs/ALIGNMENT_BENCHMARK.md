# Local alignment delivery and measurements

Measured on 26 October 2026 on the deployed Intel N150 host: four CPU cores, 16 GB RAM, CPU inference, worker limited to two cores and 6 GB RAM. Models and samples are on `/mnt/usb_4t_1/sonder/alignment/`; no user audio was uploaded and no hosted API was called.

## Delivered workflow

- Semantic app themes, validated import/export, account defaults and device overrides, cached pre-render appearance and separate reader typography.
- Sandboxed, sanitized EPUB.js reader with search, contents, bookmarks, stable CFI/sentence locators, offline ebook files and revision-aware offline reconciliation.
- Exact EPUB/recording pairing, language checks, editable chapter boundaries, HDD copies, persistent jobs, section caching, pause/resume/cancel and fingerprint invalidation.
- Local known-text alignment using the CTC engine (Wav2Vec2 Base, English only). Whisper and aeneas are retired; see ADR 0006.
- Reader → audio and audio → reader switching, optional follow-along, approximate local speech recovery when a map is missing (CTC locate on a short excerpt), and explicit sentence timing corrections.
- Independent Hardcover reading outbox, with retries and percentage/page conversion even without local audio. This does not alter the recording's native listening checkpoint or import coarse remote positions into the precise reader checkpoint.

## Samples and results

The natural narration sample is the bundled LibriVox Alice chapter read by Kara Shallenberg, clipped to 640 seconds. Text comprises 85 sentences / 2,181 words from chapter 1 of [Project Gutenberg's Alice](https://www.gutenberg.org/ebooks/11). Alignments and metrics are preserved in `alignment/benchmarks/` on the media drive.

| Test | Audio processed | Elapsed compute | Peak memory | Result |
| --- | ---: | ---: | ---: | --- |
| aeneas alone | 640 seconds | 3.82 seconds | 474 MB | 85 estimated intervals |
| aeneas + 30-second local speech check | 640 seconds | 5.73 seconds | 679 MB | 85 estimated intervals; excerpt text match 0.974 |
| Same narration, seven ebook sentences omitted | 640 seconds | 5.66 seconds | 683 MB | 78 estimated intervals; omission accuracy not certified |
| Deliberately incompatible fantasy/starship text | 640 seconds | 5.27 seconds | 693 MB | Zero intervals accepted |
| CTC / MMS 300M comparison | 120 seconds | 114.46 seconds + 0.74 seconds model load | 2,510 MB | 347 word timings; comparison only |
| Short local speech recovery at 300 seconds | 30 seconds | 4.29 seconds, cold model | included in worker budget | Matching excerpt located, token score 0.944 |
| Short local speech recovery at 20 seconds | 30 seconds | 2.54 seconds, warm model | included in worker budget | Matching excerpt located, token score 0.931 |

Speech match scores measure normalized token similarity, not timestamp accuracy or a calibrated probability. Peak memory is process lifetime high-water RSS. Model download time is excluded. No GPU was used. A simple linear extrapolation from the checked Alice sample is about 11 minutes of compute for 20 hours of audio; book length, chapter boundaries, languages, concurrent host load and edition differences can change this substantially.

The CPU CTC comparison uses commit `64293cc6d711e57666c4a8b098e9fd93b381fd88` of [ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner). It was not selected: it was much slower on this host and its current CC-BY-NC-4.0 terms complicate reuse beyond personal noncommercial deployment. Its image is a separate benchmark image, not a production dependency. Storyteller remains a reference rather than an additional deployed library service.

Short-excerpt speech recovery uses the same CTC locate path as anchored alignment (`/anchor`). The pinned Wav2Vec2 Base checkpoint is downloaded once by `download_model.py`; runtime inference loads local files only. Non-English books stay unsynced.

## Accuracy boundaries

The target of switching within one sentence at 95% of manually checked checkpoints **has not been demonstrated**. These measurements establish speed, storage and a functioning workflow, not universal sentence accuracy. Maps begin as estimated/partial and become reviewed only by explicit user action; numerical confidence is a speaking-rate heuristic. A short midpoint check can reject unrelated text but cannot detect every omission, introduction or edition difference.

For a good result, pair an unabridged same-language edition and verify the chapter start, middle and end. Trim credits/intros with the chapter start/length controls. Use manual sentence anchors for corrections. The app leaves unmatched passages unsynced and can try a short speech excerpt rather than forcing a whole-book percentage onto a sentence. Full-cast adaptations, abridgments, fantasy names and non-English accuracy require more representative listening checks.

Local audio versions are fingerprinted from track IDs/order, path, size, modification time and embedded chapters; EPUBs use SHA-256 of the actual file. Derived duration is excluded once a local file is available: browsers can report slightly different durations for the same bytes. Existing maps are upgraded only after their previous full fingerprint validates. Audio fingerprinting detects ordinary file replacements but is not a full cryptographic audio-content hash. The cache key also includes engine and normalization/check versions and explicit clip boundaries.

EPUB media-overlay (SMIL) reuse, automatic repair across large omissions, word highlighting, PDF/OCR reading and external-reader adapters remain extensions. Current synchronization uses the worker's map, its local excerpt recovery and explicit corrections. Physical iOS/Safari and Bluetooth device testing remains necessary; automated UI tests run Chromium at phone and desktop sizes.

Hosted processing remains disabled. The original [plan's pricing comparison](THEME_AND_READING_SYNC_PLAN.md#optional-hosted-fallback-and-costs) is available if difficult local cases warrant it; there is no automatic paid fallback.

## Reproduce

```bash
docker compose build alignment-worker
docker compose run --rm --no-deps alignment-worker python download_model.py
docker compose up -d --no-build alignment-worker
node scripts/benchmark-alignment.mjs \
  /mnt/usb_4t_1/sonder/alignment/benchmarks/alice-fragments.json \
  /mnt/usb_4t_1/sonder/demo/alice-01.mp3 640
```

The optional CTC comparison has its own `worker/Dockerfile.ctc-benchmark` and `worker/benchmark_ctc.py`. Its model cache is also kept on the HDD.

## Verification

Backend tests cover checkpoint revisions/idempotency/backward moves, source invalidation, local speech recovery, manual anchors, language mismatch, bookmark persistence, worker pause/reopen/cache resume, theme validation, and Hardcover reading retries without changing listening checkpoints. Browser tests cover theme changes during playback, safe EPUB rendering, reading/bookmark persistence, font and viewport changes, local mapping controls, playback switching and offline edits/reconnection, alongside existing app regressions.

Final validation: 67 backend tests and 19 browser tests passed. The three reader tests were rerun after the final paused-job rebuild change. Live HTTPS checks verified authentication, byte-range streaming, all six themes at 160% text on a 320px viewport, parsing all three existing EPUBs, visible reader content, and local speech recovery with the pinned model.


## Real library UI verification after the reported failure

The original UI flow was broken: the matcher discarded chapter numbers, so an EPUB headed `1`, `2`, etc. matched only the epilogue of the chaptered narration. The selected older release had one long track without chapter markers, and the disabled action did not explain why. Reselecting an unchanged release could also clear its options without reloading them.

These cases are corrected. Numbered/Roman-numbered chapters match before descriptive normalization, part-only headings are left out, ambiguous repeated chapter numbers require an explicit match, disabled actions show their reason, and a chaptered release is offered directly. A reader remembers its chosen release; a fresh reader prefers a recording with chapter markers when no narration is active. Completed maps remain valid when browser duration rounding changes.

The actual Dungeon Crawler Carl EPUB and the locally saved Jeff Hays English M4B were then prepared through the live UI, using the real local worker. The previous one-section/epilogue map was rebuilt into **48 sections, 13,388 sentence intervals, 99.376% text coverage**, in **412.59 seconds** of worker processing. This is measured processing, not a synthetic fixture.

The live browser then searched for individual sentences near the beginning, middle and epilogue, clicked **Listen from here**, decoded and played the real M4B, paused, and clicked **Read from audio**. It returned to the corresponding sentence in all three checks. Expected seek starts were 582.801, 22,460.712 and 48,094.502 seconds; observed starts were within 0.016 seconds of those requested map positions. These values verify seeking to the stored map; they do not themselves measure linguistic alignment accuracy.

Independent short local speech excerpts matched the same passages with normalized token scores 0.923, 0.968 and 0.898. Each excerpt began approximately one second before the selected map interval and located the preceding sentence. Three spot checks do not establish the original 95%-of-checkpoints accuracy target. The map remains explicitly estimated until reviewed.

Live QA used the real API, worker, EPUB and media stream. Only the QA browser's reading/listening checkpoint writes were intercepted, to avoid moving the user's saved positions or publishing test navigation to Hardcover. The user's normal listening could continue independently. The EPUB checkpoint remained unchanged, no browser exceptions occurred, and reopening retained the prepared release/map.

Reproduce the read/listen switching checks on an already prepared pair with:

```bash
node scripts/verify-reading-sync.mjs <ebook-id> <recording-id>
```

The script records `artifacts/reading-sync-verification.json` and a phone screenshot. It does not create processing jobs or change canonical progress. The regression suite now has 70 passing backend tests; the three reader browser tests also pass, including same-release reselection and offline release persistence.
