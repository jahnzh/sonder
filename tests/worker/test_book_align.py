"""The whole-book aligner (#402) on synthetic emissions: anchor chain, groups, seam fix, both kernels.

Needs numpy (and numba for the kernel comparison); skipped where they are missing, as on the server.
"""
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
try:
    import numpy as np
except ImportError:  # pragma: no cover - the server's test Python has no numpy
    np = None

if np is not None:
    import book_align
    from book_job import LABELS

INDEX = {label: i for i, label in enumerate(LABELS)} if np is not None else {}


def vocabulary(seed, size=1500):
    rng = random.Random(seed)
    letters = "ETAOINSHRDLUCMFWYPGBVK"
    return ["".join(rng.choice(letters) for _ in range(rng.randint(3, 8))) for _ in range(size)]


def sentences(seed, count, words):
    rng = random.Random(seed)
    return [" ".join(rng.choice(words) for _ in range(rng.randint(8, 14))).capitalize() + "." for _ in range(count)]


class Speaker:
    """Frames of a CTC-like emission stream: each letter one peak frame then two blanks."""

    def __init__(self, seed):
        self.rng = np.random.default_rng(seed)
        self.labels = []

    def pause(self, frames):
        self.labels.extend([INDEX["-"]] * frames)

    def say(self, text):
        start = len(self.labels)
        for n, word in enumerate(book_align.text_words(text)):
            if n:
                self.labels.extend([INDEX["|"], INDEX["-"]])
            for letter in word:
                self.labels.extend([INDEX[letter], INDEX["-"], INDEX["-"]])
        return start, len(self.labels)

    def babble(self, frames, words):
        """Speech that is not in the text."""
        end = len(self.labels) + frames
        while len(self.labels) < end:
            word = words[int(self.rng.integers(len(words)))][::-1]
            for letter in word:
                self.labels.extend([INDEX[letter], INDEX["-"], INDEX["-"]])
            self.labels.extend([INDEX["|"], INDEX["-"]])

    def emissions(self):
        labels = np.array(self.labels)
        logits = self.rng.normal(0, 1, (len(labels), len(LABELS))).astype(np.float32)
        logits[np.arange(len(labels)), labels] += 9.0
        logits -= np.log(np.exp(logits).sum(axis=1, keepdims=True))
        return logits.astype(np.float16)


@unittest.skipIf(np is None, "numpy is not installed")
class Kernels(unittest.TestCase):
    @unittest.skipIf(np is None or book_align.njit is None, "numba is not installed")
    def test_numpy_kernel_equals_numba_kernel(self):
        rng = np.random.default_rng(7)
        words = vocabulary(3)
        for seed in range(12):
            speaker = Speaker(seed)
            texts = sentences(seed, 12, words)
            for i, text in enumerate(texts):
                if i % 4 != 3:  # some text is not in the audio
                    speaker.say(text)
                speaker.pause(int(rng.integers(0, 30)))
            em = speaker.emissions()[: int(rng.integers(400, len(speaker.labels)))].astype(np.float32)
            longform = book_align.LongForm(em, LABELS, texts + ["", "Hello."])
            ids, first, last = longform._graph(0, len(texts) + 2)
            skips = np.where(last > first, book_align.SKIP, 0.0)
            for force_end in (False, True):
                a = book_align.viterbi(em, ids, first, last, 0, 1, book_align.DELTA, skips, force_end, kernel="numba")
                b = book_align.viterbi(em, ids, first, last, 0, 1, book_align.DELTA, skips, force_end, kernel="numpy")
                self.assertEqual(a[0], b[0])
                np.testing.assert_array_equal(a[1], b[1])
                np.testing.assert_array_equal(a[2], b[2])

    def test_numpy_kernel_aligns_known_positions(self):
        words = vocabulary(5)
        texts = sentences(5, 6, words)
        speaker = Speaker(5)
        truth = []
        for text in texts:
            speaker.pause(20)
            truth.append(speaker.say(text))
        speaker.pause(20)
        em = speaker.emissions().astype(np.float32)
        longform = book_align.LongForm(em, LABELS, texts, kernel="numpy")
        ids, first, last = longform._graph(0, len(texts))
        _, starts, ends = book_align.viterbi(em, ids, first, last, 0, 1, book_align.DELTA,
                                             np.full(len(texts), book_align.SKIP), kernel="numpy")
        for (start, end), s, e in zip(truth, starts, ends):
            self.assertLessEqual(abs(int(s) - start), 1)
            self.assertLessEqual(abs(int(e) - end), 3)


@unittest.skipIf(np is None, "numpy is not installed")
class Chain(unittest.TestCase):
    def test_longest_chain_ignores_a_wrong_location(self):
        # A narrated introduction quoting the book's middle: the location at frame 200 is wrong.
        points = [(100, 5), (200, 900), (300, 40), (400, 80), (500, 120)]
        self.assertEqual(book_align.longest_chain(points), [(100, 5), (300, 40), (400, 80), (500, 120)])

    def test_slow_links_are_dropped_and_starts_thinned(self):
        points = [(1000 * i, 100 * i) for i in range(1, 8)]
        points.insert(3, (3500, 301))  # nearly no text for 500 frames: audio not in the text
        starts, info = book_align.chain_starts(points, 1500)
        self.assertEqual(starts[0], (0, 0))
        self.assertTrue(all(b[0] - a[0] >= 1500 for a, b in zip(starts, starts[1:])))
        self.assertEqual(info["chainRateDropped"], 1)

    def test_group_tasks_overlap_and_bound_the_text(self):
        tasks = book_align.group_tasks([(0, 0), (40000, 500), (80000, 1000)], 120000)
        overlap = int(book_align.SEAM_OVERLAP_S * book_align.RATE / book_align.STRIDE)
        self.assertEqual(tasks[0]["aEnd"], 40000 + overlap)
        self.assertEqual(tasks[0]["stop"], 500 + book_align.SLACK_AFTER)
        self.assertEqual(tasks[1]["cursor"], 500 - book_align.SLACK_BEFORE)
        self.assertEqual(tasks[2]["aEnd"], 120000)
        self.assertIsNone(tasks[2]["stop"])
        self.assertEqual([t["first"] for t in tasks], [True, False, False])
        self.assertEqual([t["last"] for t in tasks], [False, False, True])

    def test_trim_keeps_the_window_commit_rule_at_group_cuts(self):
        task = {"aStart": 1000, "aEnd": 5000, "first": False, "last": False}
        raw = {1: (1000, 1100), 2: (2000, 2100), 3: (4900, 5000), 4: (3900, 3999)}
        self.assertEqual(sorted(book_align.trim_seams(raw, task, 1000)), [2, 4])
        task = {**task, "first": True, "last": True}
        self.assertEqual(sorted(book_align.trim_seams(raw, task, 1000)), [1, 2, 3, 4])

    def test_merge_prefers_earlier_groups_and_drops_order_conflicts(self):
        merged, dropped = book_align.merge_groups([{1: (10, 20), 2: (30, 40)}, {2: (31, 41), 3: (25, 28), 4: (50, 60)}])
        self.assertEqual(merged, {1: (10, 20), 2: (30, 40), 4: (50, 60)})
        self.assertEqual(dropped, 1)


@unittest.skipIf(np is None, "numpy is not installed")
class WholeBook(unittest.TestCase):
    """About 26 minutes of synthetic speech: several groups, extra audio, text missing from the audio."""

    @classmethod
    def setUpClass(cls):
        words = vocabulary(11)
        cls.texts = sentences(11, 330, words)
        speaker = Speaker(11)
        cls.truth = {}
        cls.absent = set(range(150, 156))
        for k, text in enumerate(cls.texts):
            if k == 100:
                speaker.babble(3000, words)  # a minute of audio that is not in the text
            if k in cls.absent:
                continue
            speaker.pause(15)
            cls.truth[k] = speaker.say(text)
        speaker.pause(200)
        cls.em = speaker.emissions()
        cls.longform = book_align.LongForm(cls.em, LABELS, cls.texts)
        cls.tasks, cls.info = book_align.plan_groups(cls.longform)
        outputs = [book_align.align_group(cls.longform, task)[0] for task in cls.tasks]
        cls.merged, cls.conflicts = book_align.merge_groups(outputs)
        cls.accepted = book_align.validate(cls.longform, cls.merged)

    def test_the_chain_cuts_the_book_into_groups(self):
        self.assertGreaterEqual(len(self.tasks), 2)
        self.assertEqual(self.info["groups"], len(self.tasks))

    def test_spoken_sentences_are_mapped_where_they_were_spoken(self):
        mapped = [k for k in self.truth if k in self.merged]
        self.assertGreaterEqual(len(mapped), len(self.truth) - 2)
        for k in mapped:
            start, end = self.truth[k]
            self.assertLessEqual(abs(self.merged[k][0] - start), 2, k)

    def test_no_sentence_is_lost_at_a_group_cut(self):
        for task in self.tasks[1:]:
            cut = task["aStart"]
            near = [k for k, (start, end) in self.truth.items() if abs(start - cut) < 6000]
            self.assertTrue(near)
            self.assertEqual([k for k in near if k not in self.merged], [], f"seam at frame {cut}")

    def test_text_missing_from_the_audio_is_not_mapped(self):
        self.assertEqual(self.absent & set(self.merged), set())

    def test_validation_accepts_the_mapped_sentences(self):
        self.assertGreaterEqual(len(self.accepted), 0.95 * len(self.truth))
        self.assertEqual(self.absent & set(self.accepted), set())


if __name__ == "__main__":
    unittest.main()
