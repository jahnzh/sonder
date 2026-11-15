"""The text-match check of a whole-book job (#403). Standard library only."""
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import book_match

# The measured scores of the 2026-11-14 set with this check (#403 fix round 1, WSL GPU, the job's own decode and
# encode, `artifacts/issue-403-fix-r1/score_pairs.py`): 4-grams across sentence boundaries.
MATCHING = {"antimemetics": 0.4351, "ref33h": 0.6553, "hydrogen": 0.6934, "dcc4": 0.7053,
            "phlebas-6d0150c7": 0.7154, "dcc2": 0.7276, "dcc1": 0.7367, "phlebas-b148638d": 0.7371,
            "afire": 0.7548, "dorian-546d8eee": 0.7866, "dorian-6c0bc016": 0.7955, "lhod": 0.8213,
            "dorian-3b8420b8": 0.9018}
MISMATCHED = {"snowcrash": 0.0, "wrong-lhod-on-hydrogen": 0.0, "matter-413ac442": 0.0163, "matter-7693a908": 0.0163,
              "matter-bcf7bc2c": 0.0163, "matter-c0852b41": 0.0163, "matter-c33d9257": 0.0163,
              "wrong-dcc2-on-dcc1": 0.0309}


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
        self.assertEqual((len(MATCHING), len(MISMATCHED)), (13, 8))
        # A factor of three or more from each side.
        self.assertGreater(min(MATCHING.values()) / book_match.MATCH_THRESHOLD, 4)
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
        # Exactly inspect_match.py's positions for every recording long enough for 24 samples between the edges.
        for hours in (0.5, 1, 9.7, 33):
            frames = int(hours * 3600 * 50)
            usable = frames - 2 * 120 * 50 - 60 * 50
            self.assertEqual(book_match.sample_ranges(frames),
                             [(6000 + int(usable * (i + 0.5) / 24), 6000 + int(usable * (i + 0.5) / 24) + 3000)
                              for i in range(24)])

    def test_a_short_recording_is_sampled_over_its_whole_length(self):
        # Fewer samples, spread the same way over the recording; never only its first minute.
        for seconds in (90, 150, 240, 300, 600, 1200, 1500):
            frames = seconds * 50
            ranges = book_match.sample_ranges(frames)
            self.assertGreaterEqual(len(ranges), 1, seconds)
            self.assertLessEqual(len(ranges), 24, seconds)
            self.assertTrue(all(hi - lo == 60 * 50 for lo, hi in ranges), (seconds, ranges))
            self.assertTrue(all(0 <= lo and hi <= frames for lo, hi in ranges), (seconds, ranges))
            if seconds >= 180:
                self.assertGreater(len(ranges), 1, seconds)
                # Spread over the recording: the last sample ends in its last quarter.
                self.assertGreater(ranges[-1][1], frames * 3 // 4, (seconds, ranges))
            starts = [lo for lo, _ in ranges]
            self.assertEqual(starts, sorted(set(starts)), seconds)
        self.assertEqual(len(book_match.sample_ranges(240 * 50)), 3)
        self.assertEqual(len(book_match.sample_ranges(600 * 50)), 8)

    def test_a_recording_too_short_for_one_sample_is_one_sample_of_all_of_it(self):
        for seconds in (5, 30, 60, 70):
            self.assertEqual(book_match.sample_ranges(seconds * 50), [(0, seconds * 50)], seconds)

    def test_a_short_recording_with_a_spoken_introduction_matches(self):
        # 240 s: a minute of an unrelated spoken introduction, then three minutes of this ebook's text.
        rng = random.Random(5)
        other = vocabulary(9)
        intro_end = 60 * 50

        def greedy_words(lo, hi):
            words = []
            for frame in range(lo, hi, 20):  # about 2.5 words a second
                if frame < intro_end:
                    words.append(rng.choice(other))
                else:
                    words.append(self.flat[(frame - intro_end) // 20])
            return words

        result = book_match.check(greedy_words, 240 * 50, self.book)
        self.assertTrue(result["matches"], result)
        self.assertGreater(result["score"], 0.5)
        self.assertGreater(result["samples"], 1)

    def test_short_sentences_match_as_the_heard_words_cross_them(self):
        # An ebook of three-word sentences, narrated exactly: every heard 4-gram crosses a sentence boundary.
        rng = random.Random(6)
        book = [[rng.choice(self.words) for _ in range(3)] for _ in range(4000)]
        flat = [w for sentence in book for w in sentence]

        def greedy_words(lo, hi):
            at = (lo // 3000) * 150 % (len(flat) - 150)
            return flat[at:at + 150]

        result = book_match.check(greedy_words, 1_000_000, book)
        self.assertEqual(result["wordHit"], 1.0)
        self.assertEqual(result["score"], 1.0, result)
        self.assertTrue(result["matches"])
        # 40 alternating three-word sentences and their exact concatenation (the review's probe).
        two = [["THE", "OLD", "MAN"], ["SAW", "A", "DOG"]]
        alternating = [two[k % 2] for k in range(40)]
        heard = [w for sentence in alternating for w in sentence]
        grams, vocabulary_ = book_match.book_vocabulary(alternating)
        self.assertEqual(book_match.score([heard], grams, vocabulary_)["score"], 1.0)

    def test_a_stop_ends_the_check(self):
        self.assertIsNone(book_match.check(lambda lo, hi: [], 1_000_000, self.book, should_stop=lambda: True))


if __name__ == "__main__":
    unittest.main()
