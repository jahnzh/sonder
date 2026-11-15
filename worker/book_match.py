"""Text-match check of a whole-book job (#403, ADR 0016): is this ebook the recording's text at all?

Runs in the book job after encoding and before alignment, on the job's own emissions. Up to SAMPLES
evenly spaced SAMPLE_SECONDS stretches of audio (`sample_ranges`) are decoded greedily; the score is the median share of their
heard word 4-grams found anywhere in the ebook (`scripts/arch-proto/books/inspect_match.py` on
`jahnzh/ctc-arch-more-books-2`, PROTO-D-E-BOOKS.md "Method" 4). It needs no alignment, so a wrong book
or an ebook in another language ends with the explicit TEXT_MISMATCH outcome instead of an empty map.

Standard library only: the greedy words come from the caller (`book_align.LongForm.greedy_words`).
No book text is kept in the result.
"""
import statistics

SAMPLES = 24
SAMPLE_SECONDS = 60
# Samples keep away from the first and last two minutes (credits, music); a recording shorter than
# EDGE_SECONDS * EDGE_SHARE keeps a 1 / EDGE_SHARE of its length at each end instead.
EDGE_SECONDS = 120
EDGE_SHARE = 10
# A sample with fewer heard words is not speech (music, silence) and does not count.
MIN_WORDS = 20
# The median 4-gram hit below which the ebook is not the recording's text. Measured with this check (4-grams
# across sentence boundaries; every recording is over 8 h, so 24 samples of 60 s) on the 2026-11-14 set, each
# recording encoded by the job's own stages on WSL's GPU (#403 fix round 1, `score_pairs.py`):
#   matching pairings  0.435 (Antimemetics, a later rewritten edition that only partly matches), then
#                      0.655 to 0.902 (ref33h 0.655, lhod 0.821, DCC 1 0.737, DCC 2 0.728, DCC 4 0.705,
#                      Earth Afire 0.755, Hydrogen Sonata 0.693, Consider Phlebas 0.715 and 0.737,
#                      Dorian Gray 0.787, 0.796 and 0.902);
#   mismatches         0.000 (Snow Crash: a non-English ebook; Left Hand's text on Hydrogen Sonata's audio),
#                      0.016 (Matter: the audio is another book, all five ebooks),
#                      0.031 (DCC 2's text on DCC 1's audio: same series, same narrator).
# (The first version, 4-grams within each sentence: matches 0.29 to 0.71, mismatches 0 to 0.029.)
# 0.10 stays: a factor of 3.2 above the highest mismatch and 4.4 below the lowest match. The geometric middle
# is 0.116; the threshold stays nearer the mismatches because refusing a real book loses its map, while a
# wrong book let through only runs an alignment that maps little and validates less.
MATCH_THRESHOLD = 0.10
# The result's `outcome` when the score is below MATCH_THRESHOLD; the job's `state` is still `done`.
TEXT_MISMATCH = "text_mismatch"

RATE = 16000
STRIDE = 320


def ngrams(words, n=4):
    return [tuple(words[i:i + n]) for i in range(len(words) - n + 1)]


def sample_ranges(frames, samples=SAMPLES, seconds=SAMPLE_SECONDS, edge=EDGE_SECONDS):
    """[lo, hi) frame ranges of the samples, spread evenly between the edges (inspect_match.py's positions).

    A recording with room for `samples` samples side by side between its edges (28 minutes and longer)
    gets all of them, exactly where inspect_match.py puts them; a shorter one gets as many as fit there
    side by side, spread the same way, so a spoken introduction is one sample of several, never the
    whole check. A recording too short for one sample between its edges (under 75 s) is one sample of
    all of it."""
    width = int(seconds * RATE / STRIDE)
    margin = min(int(edge * RATE / STRIDE), frames // EDGE_SHARE)
    room = frames - 2 * margin
    if room < width:
        return [(0, frames)]
    count = min(samples, room // width)
    usable = room - width
    return [(margin + int(usable * (i + 0.5) / count), margin + int(usable * (i + 0.5) / count) + width)
            for i in range(count)]


def book_vocabulary(sentence_words):
    """(the set of word 4-grams, the set of words) of the ebook, from each sentence's words in reading order.

    The 4-grams run across sentence boundaries, as the heard ones do: an ebook of short sentences (three
    words or fewer) has 4-grams only there (#403 review)."""
    flat = [word for words in sentence_words for word in words]
    return set(zip(flat, flat[1:], flat[2:], flat[3:])), set(flat)


def score(heard_samples, grams, vocabulary):
    """The check's result from each sample's greedy words: `score` (median 4-gram hit over the speech
    samples, None when no sample is speech), `matches` and the per-sample spread. No text is kept."""
    hits, word_hits = [], []
    for heard in heard_samples:
        if len(heard) < MIN_WORDS:
            continue
        heard_grams = ngrams(heard)
        hits.append(sum(g in grams for g in heard_grams) / max(1, len(heard_grams)))
        word_hits.append(sum(w in vocabulary for w in heard) / len(heard))
    median = statistics.median(hits) if hits else None
    return {"score": None if median is None else round(median, 4), "threshold": MATCH_THRESHOLD,
            "matches": median is None or median >= MATCH_THRESHOLD,
            "samples": len(heard_samples), "speechSamples": len(hits),
            "minimum": round(min(hits), 4) if hits else None, "maximum": round(max(hits), 4) if hits else None,
            "samplesOver10Percent": sum(h > 0.10 for h in hits),
            "wordHit": round(statistics.median(word_hits), 4) if word_hits else None}


def check(greedy_words, frames, sentence_words, should_stop=None):
    """Run the check: `greedy_words(lo, hi)` gives the heard words of frames [lo, hi).

    A recording with no speech sample at all (`score` None) is not called a mismatch: the alignment
    then decides (it maps nothing, so the outcome is `unsynced`). So is a recording under 75 s whose one
    sample (all of it) holds fewer than MIN_WORDS heard words."""
    grams, vocabulary = book_vocabulary(sentence_words)
    heard = []
    for lo, hi in sample_ranges(frames):
        if should_stop is not None and should_stop():
            return None
        heard.append(greedy_words(lo, hi))
    return score(heard, grams, vocabulary)
