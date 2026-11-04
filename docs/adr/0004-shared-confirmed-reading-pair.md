# One shared confirmed reading pair per work

Sonder selects one confirmed recording–EPUB pair and its alignment map per work for all users, rather than maintaining different read-along defaults for individual users or recordings. This gives users one working combination while keeping listening positions, reading positions and bookmarks personal. Additional versions, including manual additions, are evaluated in comparison with the existing confirmed pair.

## Amendment: alignment is one recording to a set of EPUBs

Supersedes the previous amendment's "confirmed EPUB" pivot. An **alignment** is defined between one recording and an **ebook set**: the EPUBs of the work that Sonder holds. It is a multiple sequence alignment of the set's texts at sentence level, with the audio aligned once to the resulting consensus text. Every EPUB in the set receives a **projected alignment map** by carrying the consensus timings across its sentence mapping. Aligning another EPUB to the audio costs a text alignment, not an audio alignment.

- **Building the set.** Adding a title searches the ebook providers and downloads the top k matches into the set. Gross outliers (obvious wrong matches) are removed. An outlier is rejected by the anchor-sample check against the audio (see the outlier rule below), so wrong editions, other books, abridgements and other translations never reach the consensus. At most k = 5 matches are downloaded per title. Because the provider's top results can be mostly wrong, k limits downloads after a cheap title/author filter, not blindly the first five rows.
- **Outlier rule.** The audio decides. Each candidate is searched for a handful of short transcribed samples spread across the recording (10 samples of 30 s in the prototype, using the existing anchor-sample matching). A candidate is an outlier if few samples are found (below half, match score about 0.5 or above counting as found) or the found samples do not move forward through the book. That cutoff ships without a separate calibration pass: the series matrix separated 12/12 from 0/12 with wide margin. Text agreement between candidates is used only afterwards, to group identical copies and to pick the pivot; it never overrides the audio. A relative text-consensus rule alone is unsafe: it follows the largest group of agreeing files, and a search can return several copies of the wrong book (see the Dungeon Crawler Carl prototype below). With no audio sample yet (the recording is not on the server), candidates are held back rather than accepted on text alone. Samples whose audio position is beyond the book's last match, and missing coverage, are failed checks, not hidden.
- **Default EPUB.** When the set first becomes usable, the shared default EPUB is the member with the best audio-supported coverage (ties → largest shared-sentence fraction with the consensus), until an administrator overrides it.
- **Tokenisation / short sentences.** Sentence splitting for alignment keeps every spoken line (no four-word minimum). The prototype's `MIN_WORDS=4` filter dropped dialogue and skewed window timings; production follows the series runs with every sentence kept.
- **Series / title audio search.** Auto-acquire prefers a single-narrator plain release. Compilations and episodic / immersion / full-cast / graphic-audio style releases are excluded from automatic acquire (they may still appear in manual search). Title queries include apostrophe-stripped variants; provider errors are retried and logged, not swallowed.
- **Prototype result (Dungeon Crawler Carl book 1).** LibGen returned the right book at rank 0 and four copies of book 3 at ranks 1–4, so the provider's top 5 is mostly wrong. Against the local reference recording, 6 downloaded book 1 files found 10 of 10 samples (mean score 0.90, 9 of 9 forward); book 2, book 3 (two copies) and a mislabelled different book found 0 of 10 (scores at most 0.19). Any cutoff between about 0.3 and 0.7 separates them. Text consensus alone, run on the provider's top 5, kept the wrong group and dropped the right file.
- **Choosing what readers see.** Which member of the set a reader opens (the default, and a user's own preference) is separate from the alignment. Every member is readable along with the narration through its projected map, so a shared default can still be one EPUB without a per-user alignment.
- **Adding later.** A manually added EPUB joins the set through the same outlier check and text alignment. Adding a new recording is the only case that needs a new audio alignment (to the existing consensus).
- **Estimates.** Timings are exact only for sentences shared by the consensus and the member. Edited sentences are interpolated and unmatched sentences have no timing; both stay labelled "estimated".
- **Tokenisation.** Sentence tokenisation must be stable across editions (normalised punctuation, case and ligatures), or the text alignment fragments.

The "confirmed pair" is reduced to a default: the recording and the EPUB shown by default, within the set.

## Amendment: membership, contribution and evidence

- **Library membership.** Confirming "Add series" adds the selected works to the user's library at once, before any files are ready. Media states (missing, queued, failed, available) are shown separately, and a failed acquisition leaves the work in the library and can be retried.
- **Series audio acquisition.** A volume that has a plain torrent candidate must still be downloadable when it is not TorBox-cached. Prefer order: TorBox cache hit → add to TorBox without `add_only_if_cached` (TorBox downloads) → local Transmission if TorBox cannot take the job. Leaving it failed with no download path is not acceptable.
- **Unreleased series positions.** A Hardcover series slot with a null release year/date and no search hits is still added to the library as **missing** (no acquisition attempt) so the position exists; search can run again when a release appears.
- **Who can add.** Every signed-in user can add an EPUB or a recording to a work. A manual EPUB joins the ebook set through the same outlier check. Only an administrator can change the default recording or default EPUB; the default stays in place until then. Members still follow the narration through their projected maps.
- **Evidence per member.** Each member of the ebook set shows sentences shared with the set, sentences only in this member, audio-supported coverage, its outlier check result, language and file size, with sample passages for any failed check. The administrator sees members side by side. Coverage alone does not establish a match.
- **Changing the set.** Adding or removing a member rebuilds the consensus only if the consensus text changes. A member that adds no sentences the consensus lacks costs a text alignment only. One that adds sentences triggers an audio re-alignment of those gaps only. A full audio re-alignment is reserved for a new recording.

## Prototype findings: edition tolerance and window size

- **Near-miss editions** (seven degraded copies of the reference EPUB, scored against the same 10 audio samples). Accepted by the rule (found at least 5 of 10, forward order): the typo, re-tokenised and abridged-by-a-quarter copies, a copy with 30% of words replaced (mean score 0.65, minimum 0.57), and a copy truncated to 60% of the text (6 of 10 found, scores unchanged). Rejected: a copy keeping a quarter of the text (2 of 10), a copy with the two halves swapped (10 of 10 found but out of order, 8 of 9 forward) and the wrong books (0 of 10). Any cutoff between 0.3 and 0.65 gives the same decisions, so the cutoff is not the sensitive part of the rule. A truncated book can not be rejected by score at all, because the samples it does contain score like the reference. The check therefore also needs to flag samples whose audio position is beyond the book's last match, and the missing coverage should be shown as a failed check, not hidden.
- **Window size.** One known-text alignment of a 4,869 s window (1,113 sentences) timed out at the worker's 850 s limit. The worker's `/tmp` is a 128 MB tmpfs and aeneas needs a wave copy plus synthetic speech there (about 178 MB for that window), so windows over roughly 40 minutes cannot succeed regardless of the time limit, and the 2-hour maximum in the README can not work at this tmpfs size. Windows between anchors about every 10 minutes, as the README describes, fit. Using only 10 samples across the book (one per 1.35 h) was too sparse for alignment, though enough for the outlier check.

## Prototype findings: one aligned window on a separate host

A 900 s window of the reference recording (206 sentences) was aligned with the worker's own code on the WSL host in 3.8 s (606 MB peak, Whisper excerpt match 0.951), so compute is not the limit; the earlier production timeout came from the 128 MB `/tmp` tmpfs alone. The result was 206 contiguous, strictly increasing intervals. Whisper spot-checks of sentences 10, 50, 100 and 150 heard the expected text (word coverage 93% to 100%, word ratio 0.53 to 0.83). Sentence 200 was wrong: the window held about 7 sentences fewer than were supplied, and the aligner compressed the unspoken sentences into the end. Two consequences for the design:

- A window's text must end where its audio ends. Estimating the sentence count from the average words per sentence overshoots; the end anchor sample must set the text range, as the README describes.
- Forced alignment always returns gapless intervals, so contiguity proves nothing. Trust comes from the excerpt check and anchors, and unaligned text at window ends must stay flagged "estimated".

Projection of those timings onto an identical second copy gave 206 of 206 sentences an exact timing; the book 2 contrast copy received 0.97%.

## Prototype findings: whole-book alignment

The README method was run end to end on the WSL host with the worker's own code: a 30 s sample every 10 minutes (82 samples, 81 matched, 80 kept as a forward chain, 0 dropped as out of order), then one known-text alignment per window between consecutive anchors. All 79 windows aligned (each 4 to 7 s, 385 s for the 13.5 h recording in total), covering sentences 17 to 11,195 of 11,352 (98%) and 30 s to 48,030 s of 48,693 s. Whisper tiny checks of the middle sentence of every window had a median word ratio of 0.97 (75 of 79 at 0.6 or above); four windows between 36,000 s and 44,000 s were below 0.6 (one at 0.0) and need inspection, whether narration departs from the text there or the check failed. The last sentence of a window is weaker (mean 0.65, 55 of 79 at 0.6 or above) because it sits next to an anchor boundary, and should stay marked "estimated". The first 17 and last 157 sentences, which hold front matter and the closing sections, were not covered because no anchor reached them.

## Prototype findings: the four weak windows

Word-level inspection of the four windows that scored below 0.6 (59, 64, 65, 71) found two timing errors and two unreliable checks. Windows 64 and 71 had correct timings (offsets 0.4 s and 0.5 s); Whisper tiny misheard short clips (a 2 s clip, and "Donut" as "don't"). Windows 59 and 65 were genuinely off, by +5.2 s and 3.8 s: the prototype's sentence splitter drops sentences under four words, so short spoken lines (dialogue) had no text and the aligner absorbed their time into neighbouring sentences. The six neighbouring windows were fine at both ends. Consequences:

- Do not filter out short sentences before alignment; every spoken line needs a fragment, even "Yes." or a single name. The prototype's four-word minimum is a defect of the prototype. The production sentence splitting was not checked here and should be.
- The Whisper check on a short single sentence is unreliable and should not be used alone to reject a window; use a clip of at least 10 s, or several sentences.

## Prototype findings: whole book without the short-sentence filter

Rerun with every sentence kept (13,568 sentences, up from 11,352; the four-word minimum had been dropping about 2,200 spoken lines) and with a stronger window check (three consecutive sentences, at least 10 s of audio, instead of one sentence). 81 of 81 candidate anchors formed the forward chain, all 80 windows aligned, 13,254 sentences were covered (98%), and the run took 394 s. Window-end sentences improved markedly (74 of 80 at 0.6 or above, mean 0.82, against 55 of 79 and 0.65), although the check changed too, so the two runs are not strictly comparable. Middle-of-window checks had a median of 0.88 (75 of 80 at 0.6 or above). Windows 59 and 64, weak before, are no longer weak; five other windows between 39,000 s and 44,000 s are (65, 68, 70, 72, 73, ratios 0.21 to 0.58), the same stretch that was weak before, which points at the narration or text there and not at the filter. That stretch has not been inspected.

## Prototype findings: whole series (Dungeon Crawler Carl)

Strategy tested, in stages that each fan out in parallel and do the cheap, shared work once:

1. **Series from Hardcover**, as ADR 0003 says. Hardcover's series lists translations, box sets and duplicates at one position, so one canonical book is chosen per integer position: not a compilation, ASCII title, lowest Hardcover id. This gave nine volumes.
2. **Search per volume, in parallel** (three volumes at a time): LibGen for ebooks, AudioBookBay and Prowlarr for audio. Each result is classified to a volume by title (longest volume-title match, then "Book N" patterns, the bare series title meaning book 1) and kept only for that volume. This avoids the bare-series-query failure where a volume's search returned other volumes.
3. **Download the top five ebooks per volume** (three at a time, two retries). 492 s for the whole series including searches. 25 of 39 attempted downloads succeeded; 23 of those 25 files could be read (one was missing on disk, one is a broken EPUB with a missing member). The failures were dead mirrors and timeouts, so a volume may end up with fewer than k files.
4. **Cluster by content, once.** 23 readable ebooks fell into exactly 8 content clusters, one per volume, with no mixed labels, so the title classification was right here. Identical copies are scored and aligned once and share the result.
5. **Audio probe, once per recording, against every cluster.** The two volumes with local audio (1 and 2) were each sampled 12 times (8 s, one process per recording) and scored against one EPUB per cluster (16 pairs, 9 s, in parallel): the matching volume found 12 of 12 samples (mean 0.90 and 0.91, forward order), every other volume 0 of 12.
6. **Align the accepted pair.** Volume 1: 80 windows in 394 s. Volume 2: 68 windows in 318 s, 69 of 69 anchors kept, 98% of sentences covered, window checks with medians 0.87 (middle) and 0.85 (end), 61 of 68 and 62 of 68 windows at 0.6 or above, the same as volume 1 (0.88 and 0.84), so the result held on a different book, file format (M4B) and narrator production.

Still open, or only partly held:

- About 10% of windows still score weakly on the Whisper check across the series; not explained, and not used alone to reject a window (timings stay, checks stay visible).
- **lisa** still needs an alignment env before it joins the SSH pool at its reserved cap (v1 is WSL + steamdeck only; see ADR 0005).
- Series lists change over time; unreleased positions stay **missing** until search finds media.


## Fetched series

TorBox-only cached fetch for Dungeon Crawler Carl volumes 3–8 (vols 1–2 used existing local audio on WSL). Volume 5 was missing from the earlier `series-audio.ts` run because AudioBookBay requests failed (`fetch failed`, swallowed by `.catch(() => null)`) and the Prowlarr title drops the apostrophe ("Butchers Masquerade"); a `fetch-resolve-vol5.ts` / `fetch-series-audio-fix.ts` path with apostrophe-stripped queries, retries, and error logging found a CACHED hash. Volume 9 (*The Beautiful Place*) has null Hardcover `release_year`/`release_date` and no search hits — treated as unreleased / not available.

Audio landed on WSL at `~/sonder-replication/ebookset-1793705357/audio/volN.*` (one file per volume). Matrix vs all 8 cluster EPUBs was strictly diagonal (12/12 on-volume, 0 elsewhere). Windowed alignment (`MIN_WORDS=1`) kept every forward-chain window.

| Vol | Title | Source title | Size | Cache | Matrix diagonal | Anchors kept | Windows ok | Sentences covered | Median mid | Median last |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Dungeon Crawler Carl | local vol1.mp3 | 774 MB | n/a (local) | 12/12 mean 0.90 fwd 11/11; others 0 | 81 kept / 81 cand | 80/80 | 13334/13568 (98%) | 0.88 | 0.84 |
| 2 | Carl's Doomsday Scenario | local vol2.m4b | 655 MB | n/a (local) | 12/12 mean 0.91 fwd 11/11; others 0 | 69 kept / 69 cand | 68/68 | 11354/11536 (98%) | 0.87 | 0.85 |
| 3 | The Dungeon Anarchist's Cookbook | The Dungeon Anarchists Cookbook (Dungeon Crawler Carl 0 | 922 MB | CACHED | 12/12 mean 0.91 fwd 11/11; others 0 | 101 kept / 101 cand | 100/100 | 16435/16694 (98%) | 0.90 | 0.84 |
| 4 | The Gate of the Feral Gods | The Gate of the Feral Gods (Dungeon Crawler Carl 04) by | 984 MB | CACHED | 12/12 mean 0.88 fwd 11/11; others 0 | 108 kept / 108 cand | 107/107 | 18018/18262 (99%) | 0.89 | 0.81 |
| 5 | The Butcher's Masquerade | The Butchers Masquerade (Dungeon Crawler Carl 05) by Ma | 1.34 GB | CACHED | 12/12 mean 0.87 fwd 11/11; others 0 | 140 kept / 140 cand | 139/139 | 23512/23753 (99%) | 0.89 | 0.82 |
| 6 | The Eye of the Bedlam Bride | The Eye of the Bedlam Bride (Dungeon Crawler 06) by Mat | 731 MB | CACHED | 12/12 mean 0.85 fwd 11/11; others 0 | 161 kept / 161 cand | 160/160 | 27338/27435 (100%) | 0.87 | 0.83 |
| 7 | This Inevitable Ruin | This Inevitable Ruin (Dungeon Crawler Carl 07) by Matt  | 1.54 GB | CACHED | 12/12 mean 0.90 fwd 11/11; others 0 | 171 kept / 171 cand | 170/170 | 27252/27465 (99%) | 0.91 | 0.83 |
| 8 | A Parade of Horribles | A PARADE OF HORRIBLES by Matt Dinniman (Audiobook)(Fict | 1.12 GB | CACHED | 12/12 mean 0.88 fwd 11/11; others 0 | 121 kept / 121 cand | 120/120 | 20173/20550 (98%) | 0.89 | 0.82 |
| 9 | The Beautiful Place | — | — | — | not available (Hardcover release_year/date null; no audio candidates) | — | — | — | — | — |

What went wrong / notes: first parallel pipeline attempt failed because isolated workdirs used symlinks for audio and `align.py` rejected resolved paths outside `MEDIA_ROOT` ("audio must be on the configured media drive"); fixed with hardlinks. Shared `alignment/` temp files also raced until each volume used its own work dir. ABB remains unreachable from this host (all queries `fetch failed`); Prowlarr alone was enough for vols 3–8 once title variants included apostrophe-stripped forms. TorBox torrent ids added are in the fetch ledger under the scratch `ws/fetch/torbox-ledger.json` (owner should delete those torrents when done).
