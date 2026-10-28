# Alignment accuracy replication (issue #6)

Status: partial. The published per-sentence and per-word alignment figures could not be reproduced, because the hand-labelled reference data behind them is not public. What was done: the public LibriSpeech alignment archive was downloaded and parsed, the two papers' metric definitions were pinned down, and the papers' internal arithmetic was checked. In a second pass the Parallel Audiobook Corpus was downloaded on the WSL host and Sonder's own alignment worker was scored on one chapter of it (last section). No Sonder code was changed.

## Sources

| Item | Source | Status |
|---|---|---|
| Braunschweiler, Gales, Buchholz, Interspeech 2010, "Lightly supervised recognition for automatic alignment of large coherent speech recordings" | https://www.isca-archive.org/interspeech_2010/braunschweiler10_interspeech.html (PDF text extracted with pypdf and read) | Read |
| Li et al., "SwanVoice", arXiv:2605.30993 | https://arxiv.org/pdf/2605.30993 (PDF text extracted with pypdf and read) | Read |
| LibriSpeech MFA alignments | Recommended Google Drive archive (about 70 MB) returned 404 from this environment. Used the Zenodo copy instead: https://zenodo.org/records/2619474, file `librispeech_alignments.zip`, 623,023,332 bytes, CC BY 4.0 | Downloaded to `artifacts/6/librispeech-mfa/` (gitignored) |
| Parallel Audiobook Corpus, Edinburgh DataShare handle 10283/3217 | https://datashare.ed.ac.uk/handle/10283/3217 | Downloaded on the WSL host and checksum-verified in the second pass (see the last section). Not on this machine |

## Method

### 1. LibriSpeech MFA alignments

- The archive contains raw Montreal Forced Aligner TextGrid files, not the condensed `.txt` format. It is the 594 MB "raw output" variant that the upstream README describes, delivered as one zip.
- `scripts/alignment-replication/mfa_textgrid.py` reads the zip in place with `zipfile`, parses the `words` tier of each TextGrid, and writes one JSON line per utterance to `artifacts/6/librispeech-mfa/words.jsonl`. It uses only the standard library and does not extract or execute anything from the archive.
- Run: `python3 -I scripts/alignment-replication/mfa_textgrid.py artifacts/6/librispeech-mfa/librispeech_alignments.zip artifacts/6/librispeech-mfa/words.jsonl` (about 5 minutes).

Result of the parse:

| Split | TextGrids parsed | Utterances in LibriSpeech (from the corpus listing, not checked here) | Difference |
|---|---|---|---|
| dev-clean | 2,703 | 2,703 | 0 |
| dev-other | 2,864 | 2,864 | 0 |
| test-clean | 2,620 | 2,620 | 0 |
| test-other | 2,938 | 2,939 | -1 |
| train-clean-100 | 28,538 | 28,539 | -1 |
| train-clean-360 | 104,008 | 104,014 | -6 |
| train-other-500 | 148,645 | 148,688 | -43 |
| **Total** | **292,316** | **292,367** | **-51** |

The upstream README says 46 raw-TextGrid utterances are unaligned. Our count of missing TextGrids is 51, which is 5 more. The expected counts come from my knowledge of the LibriSpeech release, not from a checked file. The archive has no `unaligned.txt`, so this gap cannot be settled from the data we have. It is noted here, not resolved.

The archive holds 9,615,390 labelled word intervals in the `words` tiers, silences included as empty labels.

`scripts/alignment-replication/mfa_summary.py` summarises `words.jsonl` (output: `artifacts/6/mfa_summary.json`): 292,316 utterances, 9,615,390 word intervals, no non-monotonic word intervals, median leading silence 0.25 s, median word duration 0.26 s. These describe the machine reference only and are not accuracy figures.

**These alignments are machine output, not ground truth.** The upstream README describes them as generated with the Montreal Forced Aligner. They are therefore not a reference for scoring a forced aligner. They were not used as one.

### 2. Metric definitions

The definitions below are taken from the papers. Where a paper is silent, the entry says so.

**SwanVoice, Eq. (14), accumulated averaging shift (AAS), following Shi et al. 2022 [41]:**

AAS = (1/N) Σᵢ (|t_start,i − t̂_start,i| + |t_end,i − t̂_end,i|), over N evaluated word slots.

- Each word contributes the sum of its start error and its end error. The result is then averaged over words, so the unit is ms per word, not per boundary.
- The text says "average boundary deviation across all evaluated word slots". That reads as a mean per boundary, which would be half of Eq. (14). This is an ambiguity in the paper. Eq. (14) is implemented as written.
- Not stated: the value of N, which LibriSpeech subset ("Clean" and "Others" are not defined by split), how silences or unaligned words are handled, and where the human timestamps come from.

Implemented as `aas_ms` in `scripts/alignment-replication/metrics.py`.

**Braunschweiler et al. 2010, Sec. 2 and 4, word and sentence error:**

- Word and sentence lists are aligned by longest common subsequence (LCS). Table 2.1 and Table 4.1 report substitutions, deletions and insertions, and Err equals their sum.
- The paper does not state how the unmatched items in an LCS gap are classed as substitutions versus deletions and insertions. Implemented as the usual convention: min(n_ref, n_hyp) substitutions per gap, the remainder as deletions or insertions.
- The denominator is the reference count. This is inferred from the table columns summing to Err. The paper does not state it.

Implemented as `lcs_error_counts` in `metrics.py`.

**Braunschweiler et al. 2010, Sec. 4, sentence boundary accuracy:**

- The paper gives no tolerance in ms, no labelling protocol, and no definition of "OK", "bad onset" or "bad offset". There is no definition to implement, so the check is not implemented.

### 3. Self-checks

`scripts/alignment-replication/self_check.py` runs:

- Unit checks on `aas_ms` and `lcs_error_counts` with hand-worked examples.
- Checks that the published tables are internally consistent.
- A check of the SwanVoice text against Table 3.

Output: `artifacts/6/self_check.json`. Result: 13/13 checks pass. This verifies that the code matches the definitions above. It does not verify any published number.

## Results table

"Published" is the value printed in the paper. "Ours" is what this replication produced. "Difference" is the arithmetic gap. Where we produced no value, the reason is in the last column.

| Dataset | Metric | Published | Ours | Difference | Note |
|---|---|---|---|---|---|
| *A Tramp Abroad* (LibriVox audio, manual gold not public), Braunschweiler T2.1 | Sentence Err, GOLD vs book text | 13.4% | not reproduced | n/a | Gold transcript not public |
| same | Sentence Sub / Del / Ins | 4.9 / 2.5 / 6.0 % | not reproduced | n/a | as above |
| same | Word Err, GOLD vs book text | 5.4% | not reproduced | n/a | as above |
| same, T4.1 | Sentence Err after recognition | 15.4% | not reproduced | n/a | Needs Toshiba recogniser and gold |
| same, T4.1 | Word Err after recognition | 3.3% | not reproduced | n/a | as above |
| same, T4.2 | Word Err of sentences kept at 75% threshold (BOOK) | 0.4% | not reproduced | n/a | Needs their LM and acoustic models |
| same, Sec. 4 | Sentence boundaries OK | >95% (test set about 1.5%, about 115 sentences) | not reproduced | n/a | Needs their manual labels; no tolerance defined |
| same, Sec. 4 | Bad onset 1.5%, bad offset 3.1% | 1.5%, 3.1% | not reproduced | n/a | as above |
| same, Sec. 4 | Internal check: 100 − 1.5 − 3.1 | >95% | 95.4% | n/a | Arithmetic is consistent with the ">95%" claim |
| Human-timestamped LibriSpeech set (SwanVoice Appendix C) | AAS, LibriSpeech-Clean, Swan Forced Aligner | 27.67 ms | not reproduced | n/a | Set not located; see below |
| same | AAS, LibriSpeech-Others, Swan | 29.92 ms | not reproduced | n/a | as above |
| same | AAS, LibriSpeech-Clean, Qwen3 Forced Aligner | 27.84 ms | not reproduced | n/a | Baseline not run |
| same | AAS, LibriSpeech-Clean, LattifAI | 25.70 ms | not reproduced | n/a | Baseline not run |
| same | AAS, LibriSpeech-Clean, NeMo / WhisperX | 87.05 / 87.02 ms | not reproduced | n/a | Baselines not run |
| same | AAS, LibriSpeech-Others, Qwen3 / LattifAI / NeMo / WhisperX | 29.74 / 36.00 / 91.85 / 96.64 ms | not reproduced | n/a | Baselines not run |
| SwanVoice Sec. 4 text vs Table 3 | Swan − Qwen3, LibriSpeech-Others | "within 0.18 ms" | 0.18 ms | 0.00 ms | Text matches table |
| SwanVoice Sec. 4 text vs Table 3 | Swan − LattifAI, LibriSpeech-Others | "about 10 ms behind" | −6.08 ms (Swan is lower, so better) | about 16 ms | **Text does not match table.** On Clean, Swan is 1.97 ms behind LattifAI (27.67 vs 25.70) |
| SwanVoice Table 3 | Swan AAS, GTSinger-ZH | 45.19 ms | not reproduced | n/a | Chinese set not public here |

Also checked (internal consistency only):

- SwanVoice Table 3 identifies Swan as the best open-source system on Chinese and LibriSpeech-Clean. The table bears this out: Swan 27.67 vs Qwen3 27.84 on Clean, and 45.19 vs 47.31 on Chinese. On LibriSpeech-Others, Qwen3 is best among open-source systems (29.74 vs 29.92), which the text also says.
- Braunschweiler Tables 2.1 and 4.1: each row's Sub + Del + Ins equals its Err, as printed.

## What could not be replicated, and why

1. **Braunschweiler et al. 2010, every numeric result.** These are measured against the authors' manual transcription and manually labelled sentence boundaries for *A Tramp Abroad*. The LibriVox audio and Project Gutenberg text (their footnote 1) are public, but the gold transcription is not. The recogniser (Toshiba HTK models, ToSpeak normalisation, the in-domain and Gigaword language models) is not available. The sentence-boundary check has no published tolerance, so it cannot be re-run even with the labels.
2. **SwanVoice Table 3, every AAS value.** The "human-timestamped LibriSpeech" evaluation set is not located. The paper cites it as "[1]", but reference [1] in that paper is Amodei et al., *Deep Speech 2*, so the citation is wrong. A web search in this task found no human-verified word-timestamp release of LibriSpeech. The MFA archive is machine-generated and cannot stand in for it. The Swan Forced Aligner checkpoint and the Qwen3, LattifAI, NeMo and WhisperX baselines were not run. The paper also does not state N or which LibriSpeech subset "Clean" and "Others" mean.
3. **Parallel Audiobook Corpus (step 4, first pass).** Total size is about **44.3 GB**, above the 10 GB limit, so nothing was downloaded in the first pass; the second pass downloaded it on the WSL host, see the last section. Per-file sizes from the DataShare page: chapter.emma.zip 11.34 GB, chapter.huck.zip 6.59 GB, chapter.sherlock.zip 5.13 GB, chapter.treasure.zip 3.34 GB, segmented.emma.zip 7.36 GB, segmented.huck.zip 4.38 GB, segmented.sherlock.zip 3.63 GB, segmented.treasure.zip 2.50 GB. The page does not say whether the alignments were manually checked. The README (13 KB) was not fetched, so this is unverified.
4. **The 70 MB condensed LibriSpeech file.** The Google Drive link returns 404 from this environment. The 623 MB Zenodo copy was used instead, so the raw TextGrid route was taken.
5. **Sonder's own alignment worker.** Not run in the first pass, as instructed. Run in the second pass on one corpus chapter (last section); that is agreement with a machine reference, not a replication of any published figure.

## Decisions to check

- Used the Zenodo archive (623 MB, raw TextGrids) in place of the 70 MB condensed file, which was unreachable.
- Implemented SwanVoice AAS exactly as Eq. (14) writes it (sum of both endpoints per word, averaged over words). The prose says "average boundary deviation", which would give half the value.
- Implemented LCS substitution/deletion/insertion classing as the usual convention, since the paper does not state it.
- The 51 missing TextGrids versus the 46 unaligned utterances in the upstream README is not resolved. The expected per-split counts are from memory of the corpus listing.
- Did not implement a boundary-OK metric for Braunschweiler, because the paper defines none.

## Sonder against the Parallel Audiobook Corpus

Run on the WSL host (`192.168.1.119`, run id `issue6-1793194927`, branch commit `00a0655`), with the worker's own code and pins. Scripts: `scripts/alignment-replication/remote/` (`fetch_corpus.sh`, `setup_host.sh`, `run_chapter.sh`, `align_chapter.py`, `score_chapter.py`, `segment_sentences.mjs`, `probe_excerpt.py`, `pull_results.sh`, `CLEANUP.md`). Raw output: `artifacts/6/remote/` (gitignored).

**The corpus reference is machine output.** The corpus README says the chapter word alignments were made with the Bell and Renals WFST method, not by hand. Every figure below is agreement with another automatic aligner. It is not error against ground truth, and it says nothing about which of the two is right where they differ.

### What was run

- **Corpus.** All eight zips and the README from DataShare 10283/3217 were downloaded on the host and checked against the MD5 that DataShare publishes for each file (read on the host from the DataShare API, the source of the values on the item page). Nine of nine matched, 45 GB on disk.
- **Chapter.** *Treasure Island*, chapter 17, reader `apr`. The recording is 576.0 s (22.05 kHz WAV), the shortest chapter of that reader. The Gutenberg-derived corpus transcript is the known text (1,498 word tokens, 92 sentences); the corpus ctm has 1,488 words for the chapter.
- **Worker.** `worker/align.py` `align()` imported from the clone and called directly (no server, no port, no token other than a local dummy): ffmpeg to 16 kHz mono, aeneas 1.7.3 with the worker's task configuration, then the worker's 30 s Whisper tiny excerpt check. Models were downloaded into `<run>/alignment` by `worker/download_model.py`. Python 3.10, numpy 1.26.4, aeneas 1.7.3, faster-whisper 1.2.1, espeak 1.48.15, matching `worker/Dockerfile`.
- **Two granularities.** Sentence fragments use the same splitter as `server/reader.ts` (`Intl.Segmenter` per paragraph), which is how the app calls the worker. Word fragments (one per token) are the only way to get word times from this worker; the app does not do this, so the word figures describe a use the product does not make.
- **Two scenarios.** *Untrimmed* is the whole recording with all of the text. *Trimmed* uses 30.0 s to 573.5 s and the text from the third sentence, which is what the app's chapter start and length controls do. The recording starts with about 30 s of LibriVox announcement ("This is a LibriVox recording… read by… Chapter 17. Narrative continued by the doctor…") and ends with "End of chapter 17", none of which is in the text. Whisper tiny word times (`probe_excerpt.py`) and the corpus ctm agree that the text starts at about 30.8 s. The trim points were chosen from that, the way a listener would, and not from the aeneas output.

### Results

Times are from `/usr/bin/time -v` around the whole Python process on the host under `nice -n 10`: wall clock including imports, ffmpeg, aeneas and the Whisper tiny check, and peak resident set size of the largest process. Host memory in use was about 1.1 GB when checked between runs (limit for this task: about 12 GB).

| | Untrimmed | Trimmed |
|---|---|---|
| Sentence run: wall clock / peak RSS | 3.26 s / 424 MB | 2.53 s / 405 MB |
| Word run: wall clock / peak RSS | 3.20 s / 417 MB | 3.41 s / 398 MB |
| Excerpt check match score | 0.800 | 0.878 |
| Word error, corpus words vs known text (Sub / Del / Ins over N ref) | 2 / 0 / 10 over 1,488 = 0.81% | 2 / 0 / 6 over 1,481 = 0.54% |
| Sentence error, same convention (Sub / Del / Ins over N ref) | 9 / 0 / 3 over 89 = 13.5% | 8 / 0 / 2 over 88 = 11.4% |
| Words matched for timing | 1,486 of 1,488 (99.9%) | 1,479 of 1,481 (99.9%) |
| **Word AAS** (Eq. 14, ms per word) | 2,118.9 | **429.1** |
| Word AAS per boundary (half of Eq. 14) | 1,059.4 | 214.5 |
| Word start error: median / p90 / p99 / max | 180 / 940 / 21,460 / 23,570 ms | 140 / 590 / 1,150 / 1,580 ms |
| Word end error: median / p90 / p99 / max | 160 / 730 / 21,440 / 23,090 ms | 130 / 450 / 1,000 / 1,580 ms |
| Words with start error ≤ 0.1 / 0.25 / 0.5 / 1.0 s | 34.7 / 62.0 / 81.3 / 90.5% | 38.8 / 67.5 / 87.1 / 98.1% |
| **Sentence AAS** (ms per sentence) | 1,371.2 | **628.5** |
| Sentence start error: median / p90 / max | 310 / 570 / 17,650 ms | 310 / 530 / 1,280 ms |
| Sentence end error: median / p90 / max | 310 / 580 / 13,000 ms | 305 / 540 / 780 ms |
| Sentences with start error ≤ 0.1 / 0.25 / 0.5 / 1.0 s | 12.4 / 39.3 / 86.5 / 95.5% | 12.5 / 38.6 / 87.5 / 98.9% |

Reading the table:

- **Untrimmed is dominated by the 30 s of announcement.** The worker is forced to place all the text across the whole recording, so the opening is stretched over the announcement: "This fifth trip" is placed at 7.1 s where it is spoken at about 30.8 s. Words in the first 60 s are early by a median of 8 to 12 s and by up to 24 s. After about 60 s the median error is 0.3 s or less. The excerpt check does not catch this, because it only listens to 30 s in the middle. The product mitigation is the chapter start control; without it a chapter with a long intro is badly misplaced at its start.
- **Trimmed word timing.** AAS 429 ms, median start error 140 ms, 98% of words within 1 s. The signed error (aeneas minus reference) drifts across the chapter: the median word start is about −20 ms, −90 ms and −240 ms in the first, middle and last third, so aeneas runs progressively earlier than the reference. This could be drift in either aligner; this run cannot tell.
- **Trimmed sentence timing.** The sentence start is about 300 ms before the reference and the end about 300 ms after it, in all three thirds. That is not accuracy: the worker configures aeneas with `task_adjust_boundary_percent_value=50`, and aeneas returns sentence intervals that abut each other, so each plausibly includes part of the neighbouring pauses (not checked further), while the reference sentence span is first word start to last word end. Sentence AAS here mostly measures that difference of definition. A tolerance such as 0.5 s (about 87% of starts and 85% of ends) is more meaningful than the AAS, but no tolerance is defined in either paper, so none is endorsed.
- **Word and sentence error** compare the corpus word list (reference) with the known text (hypothesis) by LCS, because a forced aligner emits no recognised words. They measure how well the text and the reference's word list agree (the insertions are title words and "17" that the ctm lacks), not any aligner mistake. They are not comparable to Braunschweiler et al.'s 5.4% word and 13.4% sentence error (a different book, a manual gold transcript, a different question).

### Caveats and decisions to check

1. **The 10 ms unit.** The corpus README says the `seg-A:B` offsets in the ctm utterance id are in 100 ms units. With 100 ms the last word of this chapter would end at 5,637 s in a 576 s recording; with 10 ms units it ends at 573.3 s and matches the audio (and Whisper's timing of the last words). The scorer asserts the ctm fits inside the audio and uses 10 ms.
2. **One chapter, one reader, one book.** No spread across readers, books or genres. The figures should not be quoted as Sonder's accuracy.
3. **Compared with the SwanVoice AAS numbers** (about 28 to 97 ms, on a different, human-timestamped set, with neural aligners) these are not comparable in either direction: different reference, different granularity, and the corpus reference is itself an aligner. The 429 ms word AAS is not a result to set beside them.
4. **Trim points** (30.0 s, 573.5 s, first sentence 2) were chosen by me from a Whisper tiny excerpt and the ctm, which are the same kind of information a person trimming by ear would have. Different trim points will move the trimmed numbers.
5. **Sentence matching** uses an LCS over normalised words (upper case, apostrophes kept, hyphens and dashes split) and attaches unmatched reference words to the preceding sentence. The reference sentence span is therefore derived from the text's sentence boundaries; it is not an independent sentence segmentation.
6. **Word fragments** put one word per fragment, which the worker accepts (limit 20,000 fragments) but the app never does. Peak memory and time for the full-book case are not shown by this chapter.
7. **Peak RSS** is that of the largest process, from `/usr/bin/time -v`; it includes the Whisper tiny model load. The worker's own `peakMemoryMB` field reports the same value.
8. **Environment differences from production.** The host has no root, no ffmpeg or espeak, and Python 3.12. The run used a private conda prefix for Python 3.10 and ffmpeg 9.0.2 (not the Debian ffmpeg in the production image) and Ubuntu 24.04 `espeak` 1.48.15 unpacked with `dpkg -x`. aeneas' C extensions built and passed `aeneas.diagnostics`. A different ffmpeg or espeak build can shift boundaries slightly.
9. **Corpus and venv were kept on the host** under `~/sonder-replication/issue6-1793194927/`. `scripts/alignment-replication/remote/CLEANUP.md` lists what is there and how to remove it. Nothing was deleted.
