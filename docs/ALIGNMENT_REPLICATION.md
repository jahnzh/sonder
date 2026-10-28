# Alignment accuracy replication (issue #6)

Status: partial. The published per-sentence and per-word alignment figures could not be reproduced, because the hand-labelled reference data behind them is not public. What was done: the public LibriSpeech alignment archive was downloaded and parsed, the two papers' metric definitions were pinned down, and the papers' internal arithmetic was checked. No Sonder alignment was run, and no Sonder code was changed.

## Sources

| Item | Source | Status |
|---|---|---|
| Braunschweiler, Gales, Buchholz, Interspeech 2010, "Lightly supervised recognition for automatic alignment of large coherent speech recordings" | https://www.isca-archive.org/interspeech_2010/braunschweiler10_interspeech.html (PDF text extracted with pypdf and read) | Read |
| Li et al., "SwanVoice", arXiv:2605.30993 | https://arxiv.org/pdf/2605.30993 (PDF text extracted with pypdf and read) | Read |
| LibriSpeech MFA alignments | Recommended Google Drive archive (about 70 MB) returned 404 from this environment. Used the Zenodo copy instead: https://zenodo.org/records/2619474, file `librispeech_alignments.zip`, 623,023,332 bytes, CC BY 4.0 | Downloaded to `artifacts/6/librispeech-mfa/` (gitignored) |
| Parallel Audiobook Corpus, Edinburgh DataShare handle 10283/3217 | https://datashare.ed.ac.uk/handle/10283/3217 | Size checked, not downloaded (see below) |

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
3. **Parallel Audiobook Corpus (step 4).** Total size is about **44.3 GB**, above the 10 GB limit, so nothing was downloaded. Per-file sizes from the DataShare page: chapter.emma.zip 11.34 GB, chapter.huck.zip 6.59 GB, chapter.sherlock.zip 5.13 GB, chapter.treasure.zip 3.34 GB, segmented.emma.zip 7.36 GB, segmented.huck.zip 4.38 GB, segmented.sherlock.zip 3.63 GB, segmented.treasure.zip 2.50 GB. The page does not say whether the alignments were manually checked. The README (13 KB) was not fetched, so this is unverified.
4. **The 70 MB condensed LibriSpeech file.** The Google Drive link returns 404 from this environment. The 623 MB Zenodo copy was used instead, so the raw TextGrid route was taken.
5. **Sonder's own alignment worker.** Not run, as instructed. Sonder-side scoring against any reference needs approval first.

## Decisions to check

- Used the Zenodo archive (623 MB, raw TextGrids) in place of the 70 MB condensed file, which was unreachable.
- Implemented SwanVoice AAS exactly as Eq. (14) writes it (sum of both endpoints per word, averaged over words). The prose says "average boundary deviation", which would give half the value.
- Implemented LCS substitution/deletion/insertion classing as the usual convention, since the paper does not state it.
- The 51 missing TextGrids versus the 46 unaligned utterances in the upstream README is not resolved. The expected per-split counts are from memory of the corpus listing.
- Did not implement a boundary-OK metric for Braunschweiler, because the paper defines none.
