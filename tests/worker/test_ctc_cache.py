"""Recording cache contracts, using only temporary media and synthetic audio."""
import os
import struct
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import ctc_acoustic
import ctc_cache
import ctc_pipeline


class CacheStorage(unittest.TestCase):
    def cache(self, folder, recording="one", engine="engine", version="v1", track="track", budget=10000):
        return ctc_cache.AcousticCache(folder, recording, engine, version, track, budget)

    def test_float32_chunks_are_isolated_by_recording_engine_and_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            first = self.cache(folder)
            data = struct.pack("<4f", 1.0, -2.5, 3.0, 4.5)
            self.assertTrue(first.write(0, 40, 2, 2, data))
            self.assertEqual(first.read(0, 2), (40, 2, data))
            for change in ({"recording": "two"}, {"engine": "new"}, {"version": "v2"}, {"track": "other"}):
                self.assertIsNone(self.cache(folder, **change).read(0, 2), change)
            # A corrupt completed marker is discarded instead of being served.
            first._path(0).write_bytes(b"incomplete")
            self.assertIsNone(first.read(0, 2))
            self.assertFalse(first._path(0).exists())

    def test_interrupted_chunk_is_not_published_and_completed_chunks_survive(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = self.cache(folder)
            data = struct.pack("<2f", 1, 2)
            self.assertTrue(cache.write(0, 40, 1, 2, data))
            with mock.patch.object(ctc_cache.os, "replace", side_effect=OSError("interrupted")):
                with self.assertRaises(OSError):
                    cache.write(1, 320040, 1, 2, data)
            self.assertIsNone(cache.read(1, 2))
            (cache._path(0).parent / "orphan.tmp").write_bytes(b"unfinished")
            restarted = self.cache(folder)
            self.assertEqual(restarted.read(0, 2), (40, 1, data))
            self.assertEqual(list(restarted._path(0).parent.glob("*.tmp")), [])

    def test_budget_evicts_least_recently_used_recording_and_never_exceeds_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            data = struct.pack("<2f", 1, 2)
            first, second = self.cache(folder, "one"), self.cache(folder, "two")
            first.write(0, 40, 1, 2, data)
            size = first._path(0).stat().st_size
            second.write(0, 40, 1, 2, data)
            second_track = self.cache(folder, "two", track="another-track")
            second_track.write(0, 40, 1, 2, data)
            # Make access order deterministic even on coarse timestamp filesystems.
            os.utime(first._path(0).parent, ns=(1_000_000_000, 1_000_000_000))
            os.utime(second._path(0).parent, ns=(2_000_000_000, 2_000_000_000))
            budget = size * 3
            first.budget = budget
            self.assertIsNotNone(first.read(0, 2))
            third = self.cache(folder, "three", budget=budget)
            self.assertTrue(third.write(0, 40, 1, 2, data))
            self.assertIsNone(second.read(0, 2))
            self.assertIsNone(second_track.read(0, 2))
            self.assertIsNotNone(first.read(0, 2))
            self.assertIsNotNone(third.read(0, 2))
            self.assertLessEqual(sum(p.stat().st_size for p in third.root.rglob("*") if p.is_file()), budget)
            tiny = self.cache(folder, "oversized", budget=size - 1)
            self.assertFalse(tiny.write(0, 40, 1, 2, data))
            self.assertLessEqual(sum(p.stat().st_size for p in tiny.root.rglob("*") if p.is_file()), size - 1)

    def test_same_size_audio_replacement_with_restored_mtime_changes_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            audio = Path(folder) / "audio"
            audio.write_bytes(b"before")
            before, _ = ctc_cache.audio_digest(audio)
            old = audio.stat()
            audio.write_bytes(b"after!")
            os.utime(audio, ns=(old.st_atime_ns, old.st_mtime_ns))
            after, _ = ctc_cache.audio_digest(audio)
            self.assertNotEqual(before, after)

    def test_digest_is_computed_once_per_file_version(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.bin"
            audio.write_bytes(b"a" * 4096)
            ctc_cache._DIGESTS.clear()
            real = ctc_cache.hashlib.sha256
            later = ctc_cache.file_version(audio)[4] + 10_000_000_000
            with mock.patch.object(ctc_cache.hashlib, "sha256", side_effect=real) as hashed, \
                    mock.patch.object(ctc_cache.time, "time_ns", return_value=later):
                first, version = ctc_cache.audio_digest(audio)
                second, again = ctc_cache.audio_digest(audio)
                self.assertEqual((first, version), (second, again))
                self.assertEqual(hashed.call_count, 1)
                # A replacement must change the file version; a write within the same
                # filesystem timestamp tick can keep it, so wait until it differs.
                for _ in range(100):
                    audio.write_bytes(b"b" * 4096)
                    if ctc_cache.file_version(audio) != version:
                        break
                    time.sleep(0.01)
                third, _ = ctc_cache.audio_digest(audio)
                self.assertNotEqual(first, third)
                self.assertEqual(hashed.call_count, 2)

    def test_a_file_written_moments_ago_is_always_hashed_again(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.bin"
            audio.write_bytes(b"a" * 4096)
            ctc_cache._DIGESTS.clear()
            real = ctc_cache.hashlib.sha256
            with mock.patch.object(ctc_cache.hashlib, "sha256", side_effect=real) as hashed:
                ctc_cache.audio_digest(audio)
                ctc_cache.audio_digest(audio)
                self.assertEqual(hashed.call_count, 2)

    def test_budget_configuration_is_bounded(self):
        self.assertEqual(ctc_cache.budget_bytes({}), 5 * 1024 ** 3)
        self.assertEqual(ctc_cache.budget_bytes({"ALIGNMENT_CTC_CACHE_BYTES": "0"}), 0)
        self.assertEqual(ctc_cache.budget_bytes({"ALIGNMENT_CTC_CACHE_BYTES": "512"}), 512)
        for invalid in ("-1", "no", str(1024 ** 4 + 1)):
            self.assertEqual(ctc_cache.budget_bytes({"ALIGNMENT_CTC_CACHE_BYTES": invalid}), ctc_cache.DEFAULT_BUDGET)


try:
    import numpy as np
    import torch
except ImportError:
    np = torch = None


@unittest.skipIf(torch is None, "torch and numpy are optional outside the worker environment")
class CachedPipeline(unittest.TestCase):
    def test_different_editions_and_boundaries_reuse_pass_then_changed_audio_reencodes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "audio.wav"
            with wave.open(str(source), "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(b"\0\0" * (65 * 16000))
            class Model:
                labels = ("-", "A", "B")
                device = torch.device("cpu")
                torch = torch
                calls = []
                fail_on = None
                def encode_chunk(self, audio, start, end, context):
                    self.calls.append(start)
                    if self.fail_on == start:
                        raise RuntimeError("simulated interrupted encode")
                    valid = max(0, (len(audio) - 400) // 320 + 1)
                    first, last = ctc_acoustic.core_frames(start, end, context, valid)
                    boundaries = [ctc_acoustic.frame_boundary(context, i) for i in range(first, last)]
                    values = torch.tensor([[float(b), 1.0, 2.0] for b in boundaries], dtype=torch.float32).unsqueeze(0)
                    return values, boundaries
            model = Model()
            paths = []
            def extract(command, *_):
                start = round(float(command[command.index("-ss") + 1]) * 16000)
                length = round(float(command[command.index("-t") + 1]) * 16000)
                with wave.open(str(source), "rb") as inp:
                    inp.setpos(min(start, inp.getnframes()))
                    frames = inp.readframes(length)
                with wave.open(command[-1], "wb") as out:
                    out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                    out.writeframes(frames)
                return 0, ""
            def align(emissions, boundaries, fragments, labels, samples, offset, _torch):
                paths.append((emissions.clone(), boundaries[:], samples, offset, fragments))
                self.assertTrue(all(0 <= b + 160 < samples for b in boundaries))
                return [{"index": 0, "start": (offset + max(0, boundaries[0])) / 16000,
                         "end": (offset + min(samples, boundaries[-1] + 320)) / 16000}]
            def run(edition, start, duration, recording="recording"):
                return ctc_pipeline.align_ctc_section(
                    audio=source, output=root / "alignment" / f"{edition}.json", fragments=[edition],
                    language="eng", start=start, duration=duration, media_folder=root / "alignment",
                    recording_id=recording, recording_fingerprint="same-recording", track_id="track")
            with mock.patch.object(ctc_pipeline, "run_with_deadline", side_effect=extract), \
                 mock.patch.object(ctc_pipeline, "resident_model", return_value=model), \
                 mock.patch.object(ctc_pipeline.ctc_path, "align", side_effect=align):
                first = run("edition-one", 8.5, 42)
                self.assertEqual(model.calls, [0, 320000, 640000])
                second = run("edition-two", 9.25, 40)
                self.assertEqual(model.calls, [0, 320000, 640000])
                self.assertGreater(first["stageTimings"]["acousticEncoding"], 0)
                self.assertEqual(second["stageTimings"]["acousticEncoding"], 0)
                self.assertGreater(second["stageTimings"]["acousticCacheRead"], 0)
                self.assertTrue(torch.equal(paths[1][0][0, :, 0], torch.tensor([b + paths[1][3] for b in paths[1][1]], dtype=torch.float32)))
                old = source.stat()
                with source.open("r+b") as audio:
                    audio.seek(-2, 2)
                    audio.write(b"\1\0")
                os.utime(source, ns=(old.st_atime_ns, old.st_mtime_ns))
                run("edition-three", 9.25, 40)
                self.assertEqual(len(model.calls), 6)
                model.calls.clear()
                model.fail_on = 320000
                with self.assertRaisesRegex(RuntimeError, "interrupted encode"):
                    run("interrupted", 8.5, 42, "interrupted-recording")
                self.assertEqual(model.calls, [0, 320000])
                model.fail_on = None
                run("resumed", 8.5, 42, "interrupted-recording")
                self.assertEqual(model.calls, [0, 320000, 320000, 640000])


if __name__ == "__main__":
    unittest.main()
