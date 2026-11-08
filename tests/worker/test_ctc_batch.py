"""Phase-1 batch locate, decode-once and GPU monitor contracts (no real GPU required)."""
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import ctc_candidates
import ctc_decode
import ctc_gpu
import ctc_pipeline
from ctc_acoustic import SAMPLE_RATE

try:
    import numpy as np
except ImportError:
    np = None

try:
    import torch
except ImportError:
    torch = None


class FragmentIndexReuse(unittest.TestCase):
    def test_index_matches_one_shot_candidate_passages(self):
        fragments = [
            "The curious rabbit ran across the garden and disappeared beneath the trees.",
            "Some intervening words lead us elsewhere.",
            "The curious rabbit ran across the garden and disappeared beneath the trees.",
        ]
        spoken = [(word, i / 2) for i, word in enumerate(fragments[0].upper().rstrip(".").split())]
        index = ctc_candidates.FragmentIndex(fragments)
        self.assertEqual(index.candidate_passages(spoken), ctc_candidates.candidate_passages(spoken, fragments))


class DecodeCache(unittest.TestCase):
    def test_second_window_reuses_decoded_wave_without_ffmpeg(self):
        if np is None:
            self.skipTest("numpy is optional outside the worker environment")
        ctc_decode.clear_decoded_cache()
        with tempfile.TemporaryDirectory() as folder:
            media = Path(folder) / "alignment"
            media.mkdir()
            audio = Path(folder) / "track.m4b"
            audio.write_bytes(b"source-audio-bytes")
            calls = []

            def fake_ffmpeg(command, *_):
                calls.append(command)
                out = Path(command[-1])
                with wave.open(str(out), "wb") as handle:
                    handle.setnchannels(1)
                    handle.setsampwidth(2)
                    handle.setframerate(SAMPLE_RATE)
                    handle.writeframes(b"\x00\x00" * SAMPLE_RATE)
                return 0, ""

            with mock.patch.object(ctc_decode, "run_with_deadline", side_effect=fake_ffmpeg):
                first, version, _seconds, hit = ctc_decode.ensure_decoded(
                    audio, media, deadline=1e9, limit=60)
                self.assertFalse(hit)
                self.assertEqual(len(calls), 1)
                self.assertEqual(len(first), SAMPLE_RATE)
                second, version2, seconds2, hit2 = ctc_decode.ensure_decoded(
                    audio, media, deadline=1e9, limit=60)
                self.assertTrue(hit2)
                self.assertEqual(len(calls), 1)
                self.assertIs(first, second)
                self.assertEqual(version, version2)
                self.assertEqual(seconds2, 0.0)


class GpuMonitor(unittest.TestCase):
    def test_mean_is_null_without_gpu_and_averages_samples_when_present(self):
        monitor = ctc_gpu.GpuMonitor(interval=0.01, reader=lambda: None)
        monitor.start()
        monitor.stop()
        self.assertIsNone(monitor.mean())

        values = iter([10, 20, 30])
        monitor = ctc_gpu.GpuMonitor(interval=0.01, reader=lambda: next(values, 30))
        monitor.start()
        time.sleep(0.035)
        monitor.stop()
        self.assertGreaterEqual(len(monitor.samples), 2)
        self.assertEqual(monitor.mean(), sum(monitor.samples) / len(monitor.samples))

    def test_nvidia_smi_helper_returns_none_when_binary_missing(self):
        self.assertIsNone(ctc_gpu.read_gpu_utilization(bin_path="/no/such/nvidia-smi"))


class BatchLocateOnce(unittest.TestCase):
    def test_batch_decodes_hashes_and_indexes_once_for_many_windows(self):
        """Structural contract that does not need torch: shared setup runs once."""
        with tempfile.TemporaryDirectory() as folder:
            media = Path(folder) / "alignment"
            media.mkdir()
            audio = Path(folder) / "track.wav"
            audio.write_bytes(b"x")
            pcm = mock.Mock()
            pcm.__len__ = mock.Mock(return_value=0)
            version = (1, 2, 3, 4, 5)
            digests = []
            indexes = []
            windows = [{"start": 5.0, "duration": 30.0}, {"start": 45.0, "duration": 30.0}]

            def fake_digest(path):
                digests.append(path)
                return ("digest", version)

            real_index = ctc_candidates.FragmentIndex

            def tracking_index(fragments):
                indexes.append(list(fragments))
                return real_index(fragments)

            class FakeCache:
                budget = 0
                def __init__(self, *_a, **_k):
                    pass
                def read(self, *_a, **_k):
                    return None
                def write(self, *_a, **_k):
                    return None

            fake_model = mock.Mock()
            fake_model.device.type = "cpu"
            fake_model.labels = ("-",)
            fake_model.encode_chunks.return_value = []

            with mock.patch.object(ctc_pipeline, "ensure_decoded", return_value=(pcm, version, 0.1, False)) as decoded, \
                 mock.patch.object(ctc_pipeline, "audio_digest", side_effect=fake_digest), \
                 mock.patch.object(ctc_pipeline, "resident_model", return_value=fake_model), \
                 mock.patch.object(ctc_candidates, "FragmentIndex", side_effect=tracking_index), \
                 mock.patch.object(ctc_pipeline, "AcousticCache", FakeCache):
                result = ctc_pipeline.align_ctc_batch_locate(
                    audio=audio, output=media / "batch.json", fragments=["One sentence here for indexing."],
                    language="eng", windows=windows, media_folder=media, track_id="t1",
                    recording_id="r1", recording_fingerprint="fp")
            self.assertEqual(decoded.call_count, 1)
            self.assertEqual(len(digests), 1)
            self.assertEqual(len(indexes), 1)
            self.assertEqual(len(result["results"]), 2)
            self.assertIn("acousticCacheKey", result["stageTimings"])
            self.assertIn("fragmentIndex", result["stageTimings"])


class BatchMatchesSingle(unittest.TestCase):
    def test_batch_locate_matches_single_window_results(self):
        if torch is None or np is None:
            self.skipTest("torch and numpy are optional outside the worker environment")
        ctc_decode.clear_decoded_cache()
        with tempfile.TemporaryDirectory() as folder:
            media = Path(folder) / "alignment"
            media.mkdir()
            audio = Path(folder) / "track.wav"
            frames = SAMPLE_RATE * 90
            with wave.open(str(audio), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(SAMPLE_RATE)
                handle.writeframes(b"\x00\x00" * frames)
            pcm = ctc_decode._load_pcm(audio)
            version = (1, 2, frames * 2, 3, 4)
            fragments = [
                "The curious rabbit ran across the garden and disappeared beneath the trees.",
                "Unrelated text that should not match the acoustic hypothesis.",
            ]
            windows = [{"start": 5.0, "duration": 30.0}, {"start": 45.0, "duration": 30.0}]
            labels = ("-", "|") + tuple("ABCDEFGHIJKLMNOPQRSTUVWXYZ'")

            class FakeModel:
                def __init__(self):
                    self.torch = torch
                    self.device = torch.device("cpu")
                    self.labels = labels

                def encode_chunks(self, items):
                    results = []
                    spoken = "THE CURIOUS RABBIT RAN ACROSS THE GARDEN AND DISAPPEARED BENEATH THE TREES"
                    ids = []
                    for word in spoken.split():
                        for letter in word:
                            ids.append(self.labels.index(letter))
                        ids.append(self.labels.index("|"))
                    for _audio_chunk, core_start, _core_end, _context_start in items:
                        n = max(8, len(ids))
                        emission = torch.zeros((1, n, len(self.labels)))
                        for i, token in enumerate(ids[:n]):
                            emission[0, i, token] = 10.0
                        boundaries = [core_start + i * 320 for i in range(n)]
                        results.append((emission, boundaries))
                    return results

            class FakeCache:
                budget = 0
                def read(self, *_args, **_kwargs):
                    return None
                def write(self, *_args, **_kwargs):
                    return None

            fake = FakeModel()
            with mock.patch.object(ctc_pipeline, "ensure_decoded", return_value=(pcm, version, 0.01, False)), \
                 mock.patch.object(ctc_pipeline, "resident_model", return_value=fake), \
                 mock.patch.object(ctc_pipeline, "AcousticCache", FakeCache), \
                 mock.patch.object(ctc_pipeline, "audio_digest", return_value=("digest", version)):
                singles = []
                for i, window in enumerate(windows):
                    singles.append(ctc_pipeline.align_ctc_section(
                        audio=audio, output=media / f"single-{i}.json", fragments=fragments,
                        language="eng", start=window["start"], duration=window["duration"],
                        media_folder=media, locate=True, track_id="t1",
                        recording_id="r1", recording_fingerprint="fp"))
                batch = ctc_pipeline.align_ctc_batch_locate(
                    audio=audio, output=media / "batch.json", fragments=fragments,
                    language="eng", windows=windows, media_folder=media, track_id="t1",
                    recording_id="r1", recording_fingerprint="fp")

            self.assertEqual(len(batch["results"]), 2)
            for single, batched in zip(singles, batch["results"]):
                self.assertEqual(batched["match"], single["match"])
                self.assertEqual(batched["matches"], single["matches"])
                self.assertEqual(batched["text"], single["text"])
                self.assertEqual(batched["start"], single["start"])
            self.assertIn("fragmentIndex", batch["stageTimings"])
            self.assertIn("acousticCacheKey", batch["stageTimings"])


if __name__ == "__main__":
    unittest.main()
