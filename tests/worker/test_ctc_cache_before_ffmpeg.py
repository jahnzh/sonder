"""MEDIUM-2: /anchor checks AcousticCache before ffmpeg and skips extraction on a full hit."""
import json
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import ctc_pipeline
from ctc_acoustic import CORE, SAMPLE_RATE

try:
    import numpy as np
except ImportError:  # optional outside the worker environment
    np = None


def _write_silence(path, seconds=1.0):
    frames = int(seconds * SAMPLE_RATE)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(b"\x00\x00" * frames)
    return path


class CacheBeforeFfmpeg(unittest.TestCase):
    def test_full_acoustic_cache_hit_skips_ffmpeg(self):
        with tempfile.TemporaryDirectory() as folder:
            media = Path(folder)
            audio = _write_silence(media / "book.wav", seconds=CORE / SAMPLE_RATE + 5)
            output = media / "alignment" / "section.json"
            label_set = ("-", "|", "A")

            class FakeModel:
                device = mock.Mock(type="cpu")
                labels = label_set

            class FakeCache:
                budget = 0
                def __init__(self, *_a, **_k):
                    pass
                def read(self, index, classes):
                    return (index * CORE + 40, 1, b"\x00" * (4 * len(label_set)))
                def write(self, *_a, **_k):
                    return None

            locate_result = {
                "match": {"index": 0, "lastIndex": 0, "score": 0.9},
                "matches": [],
                "start": 1.0,
                "text": "A",
            }
            timings = {
                "acousticCacheKey": 0.0,
                "modelReady": 0.0,
                "acousticEncoding": 0.0,
                "acousticCacheRead": 0.01,
                "acousticCacheWrite": 0.0,
                "ctcPath": 0.0,
            }

            with mock.patch.object(ctc_pipeline, "resident_model", return_value=FakeModel()), \
                 mock.patch.object(ctc_pipeline, "AcousticCache", FakeCache), \
                 mock.patch.object(ctc_pipeline, "_infer_from_pcm", return_value=(locate_result, timings)) as infer, \
                 mock.patch.object(ctc_pipeline, "run_with_deadline", side_effect=AssertionError("ffmpeg must not run")), \
                 mock.patch.object(ctc_pipeline.ctc_prefetch, "take", side_effect=AssertionError("prefetch must not run")):
                result = ctc_pipeline.align_ctc_section(
                    audio=audio,
                    output=output,
                    fragments=["A sentence."],
                    language="eng",
                    start=1.0,
                    duration=2.0,
                    media_folder=media,
                    recording_id="rec-1",
                    recording_fingerprint="fp",
                    track_id="track-1",
                    locate=True,
                    ffmpeg="/bin/false",
                )
            self.assertEqual(result["outcome"], "mapped")
            self.assertEqual(result["stageTimings"]["acousticCacheHit"], 1.0)
            self.assertEqual(result["stageTimings"]["extractionPrefetched"], 0.0)
            self.assertEqual(infer.call_count, 1)
            self.assertIsInstance(infer.call_args.args[0], ctc_pipeline._LengthOnly)
            self.assertEqual(json.loads(output.read_text())["match"]["index"], 0)
            self.assertFalse(output.with_suffix(".ctc.wav").exists())

    @unittest.skipIf(np is None, "numpy is optional outside the worker environment")
    def test_offset_window_exposes_absolute_indices_without_prefix_allocation(self):
        window = np.arange(10, dtype="float32")
        pcm = ctc_pipeline.OffsetWindow(window, offset=1_000_000)
        self.assertEqual(len(pcm), 1_000_010)
        self.assertTrue(np.array_equal(pcm.slice(1_000_000, 1_000_005), window[:5]))
        padded = pcm.slice(999_998, 1_000_002)
        self.assertEqual(list(padded), [0.0, 0.0, 0.0, 1.0])

    def test_offset_window_length_without_numpy(self):
        pcm = ctc_pipeline.OffsetWindow([0.0, 1.0, 2.0], offset=50)
        self.assertEqual(len(pcm), 53)
        self.assertEqual(len(ctc_pipeline._LengthOnly(12)), 12)


if __name__ == "__main__":
    unittest.main()
