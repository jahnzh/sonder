"""The Whisper arm of the probing gate answers like /anchor, transcribing each sample once."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import gate_whisper_probe

WORDS = "the quick brown fox jumps over the lazy dog near the old river bank".split()
SAMPLE = [{"text": f" {word}", "start": 100 + i, "end": 100.5 + i} for i, word in enumerate(WORDS)]


class GateWhisperProbeTest(unittest.TestCase):
    def test_each_sample_is_transcribed_once_and_matched_to_every_candidate(self):
        calls = []

        def transcribe(audio, folder, start, duration, language):
            calls.append((start, duration, language))
            return SAMPLE

        candidates = {
            "right": ["Intro heading.", "The quick brown fox jumps over the lazy dog near the old river bank."],
            "wrong": ["Something else entirely, with no overlap at all in these words whatsoever."],
        }
        samples = [{"time": 100, "duration": 30}, {"time": 700, "duration": 30}]
        with tempfile.TemporaryDirectory() as folder:
            results = gate_whisper_probe.probe_title("a.mp3", folder, samples, candidates, transcribe=transcribe)
        self.assertEqual(calls, [(100, 30, "eng"), (700, 30, "eng")])
        self.assertEqual(results["right"][0]["match"]["index"], 1)
        self.assertGreaterEqual(results["right"][0]["match"]["score"], 0.5)
        self.assertEqual(results["right"][0]["start"], 100)
        self.assertIsNone(results["wrong"][0]["match"])
        self.assertEqual(results["right"][0]["text"], " ".join(WORDS))

    def test_a_silent_sample_keeps_its_own_start_and_has_no_match(self):
        result = gate_whisper_probe.locate([], ["Some text here for the book to hold."], 640)
        self.assertEqual(result, {"text": "", "start": 640, "match": None})

    def test_the_transcript_cache_skips_transcription_and_is_saved(self):
        saved = []
        cache = {"100:30": SAMPLE}

        def fail(*_):
            raise AssertionError("cached sample must not be transcribed again")

        gate_whisper_probe.probe_title("a.mp3", "/tmp", [{"time": 100, "duration": 30}], {"c": ["x y z"]}, transcribe=fail, cache=cache, save=saved.append)
        self.assertEqual(saved, [])
        fresh = {}
        gate_whisper_probe.probe_title("a.mp3", "/tmp", [{"time": 5, "duration": 30}], {"c": ["x y z"]}, transcribe=lambda *_: SAMPLE, cache=fresh, save=saved.append)
        self.assertEqual(list(fresh), ["5:30"])
        self.assertEqual(len(saved), 1)


if __name__ == "__main__":
    unittest.main()
