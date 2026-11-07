"""Tests for speech excerpt transcription and anchor location concurrency."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import anchors


class FakeWord:
    def __init__(self, word, start, end):
        self.word = word
        self.start = start
        self.end = end


class FakeSegment:
    def __init__(self, words):
        self.words = words


class AnchorsTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.folder = Path(self.temp_dir.name)
        self.audio = self.folder / "dummy.m4b"
        self.audio.write_bytes(b"dummy audio data")
        self.fragments = [
            "Call me Ishmael.",
            "Some years ago - never mind how long precisely - having little or no money in my purse.",
        ]

    def test_two_overlapping_locate_excerpt_calls_do_not_collide(self):
        call1_inside = threading.Event()
        call2_inside = threading.Event()
        release_call1 = threading.Event()
        sample_paths = []
        errors = []

        fake_model = mock.MagicMock()

        def fake_transcribe(sample_file, **kwargs):
            path = Path(sample_file)
            sample_paths.append(path)
            # Verify the sample file actually exists on disk inside the alignment folder
            if not path.is_file():
                errors.append(f"Sample file {path} does not exist on disk")
            if path.name == "anchor-sample.wav":
                errors.append("Sample file must not use fixed name anchor-sample.wav")

            if len(sample_paths) == 1:
                # Call 1 entered transcribe
                call1_inside.set()
                # Wait until Call 2 has also entered transcribe
                if not call2_inside.wait(timeout=5):
                    errors.append("Timed out waiting for call 2 to enter transcribe")
                # Wait a moment so Call 2 is verified to be concurrently inside transcribe
                release_call1.wait(timeout=5)
            elif len(sample_paths) == 2:
                # Call 2 entered transcribe while Call 1 is still inside
                call2_inside.set()
                # Check that both sample files exist simultaneously and have unique names
                if sample_paths[0] == sample_paths[1]:
                    errors.append(f"Sample files collided: {sample_paths[0]} == {sample_paths[1]}")
                if not sample_paths[0].is_file():
                    errors.append(f"Call 1 sample {sample_paths[0]} disappeared before Call 1 finished")
                if not sample_paths[1].is_file():
                    errors.append(f"Call 2 sample {sample_paths[1]} does not exist")
                # Let Call 1 finish and unlink its file first
                release_call1.set()
                # Wait briefly to ensure Call 1's finally block unlinks Call 1's sample
                import time
                time.sleep(0.05)
                # Call 2's sample must still be present even after Call 1 finished and unlinked its sample
                if not path.is_file():
                    errors.append(f"Call 2 sample {path} was deleted when Call 1 cleaned up!")

            words = [
                FakeWord("call", 0.0, 0.5),
                FakeWord("me", 0.5, 0.9),
                FakeWord("ishmael", 1.0, 1.8),
                FakeWord("some", 1.8, 2.2),
                FakeWord("years", 2.2, 2.8),
                FakeWord("ago", 2.8, 3.2),
            ]
            return [FakeSegment(words)], None

        fake_model.transcribe.side_effect = fake_transcribe

        results = {}

        def run_call(call_id):
            try:
                res = anchors.locate_excerpt(
                    self.audio, self.folder, self.fragments, start=0, duration=30, language="eng"
                )
                results[call_id] = res
            except Exception as e:
                errors.append(f"Call {call_id} raised: {e!r}")

        with mock.patch.object(anchors, "_model", fake_model), \
             mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)):
            t1 = threading.Thread(target=run_call, args=(1,))
            t2 = threading.Thread(target=run_call, args=(2,))
            t1.start()
            call1_inside.wait(timeout=5)
            t2.start()
            t1.join(timeout=10)
            t2.join(timeout=10)

        self.assertEqual(errors, [])
        self.assertIn(1, results)
        self.assertIn(2, results)
        self.assertIsNotNone(results[1]["match"])
        self.assertIsNotNone(results[2]["match"])
        self.assertEqual(results[1]["match"]["index"], 0)
        self.assertEqual(results[2]["match"]["index"], 0)

        # Both sample files had distinct paths
        self.assertEqual(len(sample_paths), 2)
        self.assertNotEqual(sample_paths[0], sample_paths[1])
        # Neither sample file used the fixed name
        self.assertNotEqual(sample_paths[0].name, "anchor-sample.wav")
        self.assertNotEqual(sample_paths[1].name, "anchor-sample.wav")

        # No temporary files remain under the alignment folder (only dummy.m4b remains)
        leftovers = sorted(p.name for p in self.folder.iterdir() if p != self.audio)
        self.assertEqual(leftovers, [], "no temporary file remains under alignment")
        self.assertFalse((self.folder / "anchor-sample.wav").exists())

    def test_no_fixed_temporary_file_name_remains_under_alignment(self):
        created_samples = []
        fake_model = mock.MagicMock()

        def fake_transcribe(sample_file, **kwargs):
            path = Path(sample_file)
            created_samples.append(path)
            self.assertTrue(path.is_file())
            self.assertNotEqual(path.name, "anchor-sample.wav")
            words = [
                FakeWord("call", 0.0, 0.5),
                FakeWord("me", 0.5, 0.9),
                FakeWord("ishmael", 1.0, 1.8),
                FakeWord("some", 1.8, 2.2),
                FakeWord("years", 2.2, 2.8),
                FakeWord("ago", 2.8, 3.2),
            ]
            return [FakeSegment(words)], None

        fake_model.transcribe.side_effect = fake_transcribe

        with mock.patch.object(anchors, "_model", fake_model), \
             mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)):
            res = anchors.locate_excerpt(
                self.audio, self.folder, self.fragments, start=0, duration=30, language="eng"
            )

        self.assertIsNotNone(res["match"])
        self.assertEqual(len(created_samples), 1)
        self.assertNotEqual(created_samples[0].name, "anchor-sample.wav")
        self.assertFalse(created_samples[0].exists())
        self.assertFalse((self.folder / "anchor-sample.wav").exists())
        leftovers = [p.name for p in self.folder.iterdir() if p != self.audio]
        self.assertEqual(leftovers, [])

    def test_temporary_file_removed_on_transcription_error(self):
        created_samples = []
        fake_model = mock.MagicMock()

        def fake_transcribe(sample_file, **kwargs):
            path = Path(sample_file)
            created_samples.append(path)
            self.assertTrue(path.is_file())
            raise RuntimeError("transcription failed")

        fake_model.transcribe.side_effect = fake_transcribe

        with mock.patch.object(anchors, "_model", fake_model), \
             mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)):
            with self.assertRaises(RuntimeError):
                anchors.locate_excerpt(
                    self.audio, self.folder, self.fragments, start=0, duration=30, language="eng"
                )

        self.assertEqual(len(created_samples), 1)
        self.assertFalse(created_samples[0].exists(), "per-request temporary file is cleaned up in finally")
        self.assertFalse((self.folder / "anchor-sample.wav").exists())
        leftovers = [p.name for p in self.folder.iterdir() if p != self.audio]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
