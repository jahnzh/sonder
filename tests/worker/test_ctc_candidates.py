import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from ctc_candidates import candidate_passages, greedy_words


class CTCCandidates(unittest.TestCase):
    def test_greedy_collapse_keeps_repeated_letters_and_original_times(self):
        labels = ("-", "A", "B", "|")
        result = greedy_words([0, 1, 1, 0, 1, 3, 2, 2, 0], labels,
                              [i * 320 for i in range(9)], 16000)
        self.assertEqual(result, [("AA", 1.02), ("B", 1.12)])

    def test_repeated_passages_keep_alternatives_and_unrelated_text_is_refused(self):
        repeated = "The curious rabbit ran across the garden and disappeared beneath the trees."
        fragments = [repeated, "Some intervening words lead us elsewhere.", repeated]
        spoken = [(word, i / 2) for i, word in enumerate(repeated.upper().rstrip(".").split())]
        matches = candidate_passages(spoken, fragments)
        self.assertEqual([item["index"] for item in matches], [0, 2])
        self.assertEqual(matches[0]["start"], 0)
        self.assertEqual(candidate_passages(spoken, ["A submarine explores the deep ocean."]), [])

    def test_query_errors_still_find_the_correct_local_passage(self):
        spoken = [(word, float(i)) for i, word in enumerate(
            "THE CURIOUS RABBIT RUN ACROSS THE GARDEN AND DISAPPEARED BENEATH TREES".split())]
        fragments = ["A different passage in the book.",
                     "The curious rabbit ran across the garden and disappeared beneath the trees."]
        matches = candidate_passages(spoken, fragments)
        self.assertEqual(matches[0]["index"], 1)
        self.assertGreater(matches[0]["score"], 0.7)

    def test_search_keeps_a_match_crossing_bounded_text_scopes(self):
        sentence = "THE CURIOUS RABBIT RAN ACROSS THE GARDEN AND DISAPPEARED"
        spoken = [(word, float(i)) for i, word in enumerate(sentence.split())]
        matches = candidate_passages(spoken, ["ZZZ " * 8190, sentence])
        self.assertEqual(matches[0]["index"], 1)
        self.assertEqual(matches[0]["score"], 1)
        self.assertEqual(candidate_passages(spoken * 30, [sentence]), [])


if __name__ == "__main__":
    unittest.main()
