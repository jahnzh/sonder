"""The text-match check of a whole-book job (#403). Standard library only."""
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import book_match

# The measured scores of the 2026-11-14 set (proto-d-e-results/books/*/match-*.json: gram4_hit_median).
MATCHING = {"antimemetics": 0.2915, "dcc4": 0.5076, "ref33h": 0.5271, "afire": 0.5358, "dcc1": 0.5427,
            "dcc2": 0.5438, "hydrogen": 0.5619, "dorian-546d8eee": 0.5767, "dorian-6c0bc016": 0.6090,
            "phlebas-b148638d": 0.6166, "phlebas-6d0150c7": 0.6203, "dorian-3b8420b8": 0.6563, "lhod": 0.6937}
MISMATCHED = {"snowcrash": 0.0, "wrong-lhod-on-hydrogen": 0.0, "matter (x5)": 0.0138, "wrong-dcc2-on-dcc1": 0.0291}


def vocabulary(seed, size=3000):
    rng = random.Random(seed)
    return ["".join(rng.choice("ETAOINSHRDLUCMFWYPGB") for _ in range(rng.randint(3, 8))) for _ in range(size)]


class Check(unittest.TestCase):
    def setUp(self):
        rng = random.Random(1)
        self.words = vocabulary(1)
        self.book = [[rng.choice(self.words) for _ in range(12)] for _ in range(2000)]
        self.flat = [w for sentence in self.book for w in sentence]

    def greedy(self, share_heard, rng):
        """`greedy_words(lo, hi)` hearing the book's text with a share of words misrecognised."""
        def greedy_words(lo, hi):
            at = rng.randrange(len(self.flat) - 200)
            return [w if rng.random() < share_heard else w[::-1] + "Q" for w in self.flat[at:at + 150]]
        return greedy_words

    def test_the_threshold_separates_every_measured_pairing(self):
        self.assertGreater(min(MATCHING.values()), book_match.MATCH_THRESHOLD)
        self.assertLess(max(MISMATCHED.values()), book_match.MATCH_THRESHOLD)
        # A factor of about three from each side.
        self.assertGreater(min(MATCHING.values()) / book_match.MATCH_THRESHOLD, 2.5)
        self.assertGreater(book_match.MATCH_THRESHOLD / max(MISMATCHED.values()), 3)

    def test_the_book_read_with_recognition_errors_matches(self):
        result = book_match.check(self.greedy(0.9, random.Random(2)), 1_000_000, self.book)  # 0.9^4: ~0.66
        self.assertTrue(result["matches"])
        self.assertGreater(result["score"], 0.4)
        self.assertEqual(result["samples"], book_match.SAMPLES)
        self.assertEqual(result["speechSamples"], book_match.SAMPLES)
        self.assertEqual(result["threshold"], book_match.MATCH_THRESHOLD)

    def test_another_book_does_not_match(self):
        rng = random.Random(3)
        other = vocabulary(9)
        result = book_match.check(lambda lo, hi: [rng.choice(other + self.words) for _ in range(150)], 1_000_000,
                                  self.book)
        self.assertFalse(result["matches"])
        self.assertLess(result["score"], book_match.MATCH_THRESHOLD)
        self.assertEqual(book_match.TEXT_MISMATCH, "text_mismatch")

    def test_no_speech_is_not_a_mismatch(self):
        result = book_match.check(lambda lo, hi: ["A", "B"], 1_000_000, self.book)
        self.assertIsNone(result["score"])
        self.assertEqual(result["speechSamples"], 0)
        self.assertTrue(result["matches"])  # the alignment decides: it maps nothing, so `unsynced`

    def test_the_result_holds_no_text(self):
        result = book_match.check(self.greedy(0.9, random.Random(4)), 1_000_000, self.book)
        text = repr(result)
        self.assertFalse(any(w in text for w in self.words if len(w) >= 5))

    def test_samples_as_inspect_match(self):
        frames = 50 * 3600  # one hour
        ranges = book_match.sample_ranges(frames)
        self.assertEqual(len(ranges), 24)
        self.assertGreaterEqual(ranges[0][0], 120 * 50)
        self.assertLessEqual(ranges[-1][1], frames - 120 * 50)
        self.assertTrue(all(hi - lo == 60 * 50 for lo, hi in ranges))
        self.assertEqual(book_match.sample_ranges(250 * 50), [(0, 60 * 50)])  # too short to keep the edges
        self.assertEqual(book_match.sample_ranges(30 * 50), [(0, 30 * 50)])

    def test_a_stop_ends_the_check(self):
        self.assertIsNone(book_match.check(lambda lo, hi: [], 1_000_000, self.book, should_stop=lambda: True))


if __name__ == "__main__":
    unittest.main()
