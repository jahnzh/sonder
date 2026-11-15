"""Text-match check of a whole-book job (#403, ADR 0016): is this ebook the recording's text at all?

Runs in the book job after encoding and before alignment, on the job's own emissions. SAMPLES evenly
spaced SAMPLE_SECONDS stretches of audio are decoded greedily; the score is the median share of their
heard word 4-grams found anywhere in the ebook (`scripts/arch-proto/books/inspect_match.py` on
`jahnzh/ctc-arch-more-books-2`, PROTO-D-E-BOOKS.md "Method" 4). It needs no alignment, so a wrong book
or an ebook in another language ends with the explicit TEXT_MISMATCH outcome instead of an empty map.

Standard library only: the greedy words come from the caller (`book_align.LongForm.greedy_words`).
No book text is kept in the result.
"""
import statistics

SAMPLES = 24
SAMPLE_SECONDS = 60
# Samples keep away from the first and last two minutes (credits, music) when the recording is long enough.
EDGE_SECONDS = 120
# A sample with fewer heard words is not speech (music, silence) and does not count.
MIN_WORDS = 20
# The median 4-gram hit below which the ebook is not the recording's text. Measured on the 2026-11-14 set
# (PROTO-D-E-BOOKS.md, `proto-d-e-results/books/*/match-*.json`, 24 samples of 60 s each):
#   matching pairings  0.29 (Antimemetics, a later rewritten edition that only partly matches), then
#                      0.51 to 0.69 (DCC 1, 2 and 4, Earth Afire, Hydrogen Sonata, Left Hand of Darkness,
#                      Consider Phlebas x2, Dorian Gray x3, the 33 h book);
#   mismatches         0.000 (Snow Crash: a non-English ebook; Left Hand's text on Hydrogen Sonata's audio),
#                      0.014 (Matter: the audio is another book, all five ebooks),
#                      0.029 (DCC 2's text on DCC 1's audio: same series, same narrator).
# 0.10 is about the geometric middle of 0.029 and 0.29 (0.092), rounded up: a factor of three from each side.
MATCH_THRESHOLD = 0.10
# The result's `outcome` when the score is below MATCH_THRESHOLD; the job's `state` is still `done`.
TEXT_MISMATCH = "text_mismatch"

RATE = 16000
STRIDE = 320


def ngrams(words, n=4):
    return [tuple(words[i:i + n]) for i in range(len(words) - n + 1)]


def sample_ranges(frames, samples=SAMPLES, seconds=SAMPLE_SECONDS, edge=EDGE_SECONDS):
    """[lo, hi) frame ranges of the samples, as inspect_match.py: spread evenly between the edges when the
    recording is longer than both edges and one sample, else one sample from the start."""
    width = int(seconds * RATE / STRIDE)
    margin = int(edge * RATE / STRIDE)
    if frames <= 2 * margin + width:
        return [(0, min(frames, width))]
    usable = frames - 2 * margin - width
    return [(margin + int(usable * (i + 0.5) / samples), margin + int(usable * (i + 0.5) / samples) + width)
            for i in range(samples)]


def book_vocabulary(sentence_words):
    """(the set of word 4-grams, the set of words) of the ebook, from each sentence's words."""
    grams, vocabulary = set(), set()
    for words in sentence_words:
        vocabulary.update(words)
        grams.update(ngrams(words))
    return grams, vocabulary


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
    then decides (it maps nothing, so the outcome is `unsynced`)."""
    grams, vocabulary = book_vocabulary(sentence_words)
    heard = []
    for lo, hi in sample_ranges(frames):
        if should_stop is not None and should_stop():
            return None
        heard.append(greedy_words(lo, hi))
    return score(heard, grams, vocabulary)
