import string
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from ctc_validation import accepted_intervals


LABELS = ("-", "|") + tuple(string.ascii_uppercase) + ("'",)


def speech(sentences):
    path, intervals = [], []
    for index, sentence in enumerate(sentences):
        start = len(path) * 0.02
        for word in sentence.upper().split():
            for letter in word:
                path.extend([LABELS.index(letter), 0])
            path.extend([1] + [0] * 10)
        intervals.append({"index": index, "start": start, "end": len(path) * 0.02})
    return path, [i * 320 for i in range(len(path))], intervals


class CTCValidation(unittest.TestCase):
    def test_matching_speech_keeps_first_and_last_sentences(self):
        fragments = ["THE CURIOUS RABBIT CROSSED THE GARDEN",
                     "ALICE FOLLOWED HIM UNDER THE OLD TREES",
                     "THE EVENING SUNLIGHT FELL ACROSS THE RIVER"]
        path, boundaries, intervals = speech(fragments)
        self.assertEqual(accepted_intervals(path, boundaries, intervals, fragments, LABELS, 0), intervals)

    def test_wrong_chapter_and_local_omission_are_left_unsynced(self):
        fragments = ["THE CURIOUS RABBIT CROSSED THE GARDEN",
                     "ALICE FOLLOWED HIM UNDER THE OLD TREES",
                     "THE EVENING SUNLIGHT FELL ACROSS THE RIVER"]
        different = ["THE FISHERMAN TRAVELED OVER THE OCEAN",
                     "HIS VESSEL CARRIED A HEAVY CARGO",
                     "A STORM WAS GATHERING NEAR THE ISLAND"]
        path, boundaries, intervals = speech(different)
        self.assertEqual(accepted_intervals(path, boundaries, intervals, fragments, LABELS, 0), [])
        path, boundaries, intervals = speech([fragments[0], different[1], fragments[2]])
        self.assertEqual([item["index"] for item in accepted_intervals(path, boundaries, intervals, fragments, LABELS, 0)], [0, 2])

    def test_blank_only_and_implausible_timing_are_rejected(self):
        fragments = ["THE CURIOUS RABBIT CROSSED THE GARDEN"]
        path, boundaries, intervals = speech(fragments)
        self.assertEqual(accepted_intervals([0] * len(path), boundaries, intervals, fragments, LABELS, 0), [])
        intervals[0]["end"] = 100
        self.assertEqual(accepted_intervals(path, boundaries, intervals, fragments, LABELS, 0), [])

    def test_merged_word_boundary_and_spelling_error_keep_letter_evidence(self):
        reference = ["THE COURIER WILL FETCH A RED PACKAGE"]
        path, boundaries, intervals = speech(["THE COURIER WILL FETCH ARED PACKIGE"])
        self.assertEqual(accepted_intervals(path, boundaries, intervals, reference, LABELS, 0), intervals)


if __name__ == "__main__":
    unittest.main()
