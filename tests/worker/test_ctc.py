"""Model-free CTC contracts; optional tensor test skips without torch."""
import hashlib
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import ctc_acoustic
import ctc_path
import ctc_pipeline
import gate_ctc
from deadline import AlignmentTimeout, Gate, WorkerBusy


class Timeline(unittest.TestCase):
    def test_context_and_convolution_grid_keep_seams_and_final_valid_frames(self):
        total = 41 * 16000 + 101
        pieces = list(ctc_acoustic.chunks(total))
        self.assertEqual(pieces, [(0, 320000, 0, 400000), (320000, 640000, 240000, total),
                                  (640000, total, 560000, total)])
        boundaries = []
        for start, end, lo, hi in pieces:
            valid = max(0, (hi - lo - 400) // 320 + 1)
            first, last = ctc_acoustic.core_frames(start, end, lo, valid)
            boundaries.extend(ctc_acoustic.frame_boundary(lo, i) for i in range(first, last))
        expected = list(range(40, total - 199, 320))
        self.assertEqual(boundaries, expected)
        self.assertEqual(boundaries[1000], 320040)
        self.assertLess(boundaries[-1] + 200, total)

    def test_returned_valid_length_bounds_padded_frames(self):
        self.assertEqual(ctc_acoustic.core_frames(320000, 640000, 240000, 255), (250, 255))
        self.assertEqual(ctc_acoustic.core_frames(320000, 640000, 240000, 249), (249, 249))

    def test_tokenization_and_track_offset_preserve_first_and_last_fragments(self):
        labels = tuple("-|ABCDEFGHIJKLMNOPQRSTUVWXYZ'")
        ids, owners = ctc_path.tokenize(["Élan’s", "...", "Last!"], labels)
        self.assertEqual("".join(labels[i] for i in ids), "ELAN'S|LAST")
        spans = [SimpleNamespace(start=i, end=i + 1) for i in range(len(ids))]
        times = [40 + i * 320 for i in range(len(ids))]
        intervals = ctc_path.intervals_for_spans(spans, owners, times, 16000, 80000)
        self.assertEqual([item["index"] for item in intervals], [0, 2])
        self.assertEqual(intervals[0]["start"], (80000 + 40) / 16000)
        self.assertEqual(intervals[-1]["end"], (80000 + times[-1] + 320) / 16000)


class ModelLifetime(unittest.TestCase):
    def test_checkpoint_digest_is_checked_and_missing_file_never_downloads(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "model.pth"
            path.write_bytes(b"pinned bytes")
            with mock.patch.object(ctc_acoustic, "CHECKPOINT_SHA256", hashlib.sha256(b"pinned bytes").hexdigest()):
                ctc_acoustic.verify_checkpoint(path)
                path.write_bytes(b"changed bytes")
                with self.assertRaises(ValueError):
                    ctc_acoustic.verify_checkpoint(path)
                with self.assertRaises(FileNotFoundError):
                    ctc_acoustic.verify_checkpoint(path.with_name("missing"))

    def test_concurrent_requests_load_once_and_cannot_switch_roots(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(ctc_acoustic, "_model", None), \
             mock.patch.object(ctc_acoustic, "_model_folder", None), \
             mock.patch.object(ctc_acoustic, "AcousticModel", side_effect=lambda _: object()) as loader:
            models = []
            threads = [threading.Thread(target=lambda: models.append(ctc_acoustic.resident_model(folder))) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(loader.call_count, 1)
            self.assertTrue(all(model is models[0] for model in models))
            with self.assertRaises(ValueError):
                ctc_acoustic.resident_model(Path(folder) / "another")

    def test_encoder_uses_model_valid_length_when_torch_is_installed(self):
        try:
            import numpy as np
            import torch
        except ImportError:
            self.skipTest("torch and numpy are optional outside the worker environment")
        calls = []
        def model(wave, lengths):
            calls.append(lengths.tolist())
            return torch.ones((1, 5, 3)), torch.tensor([2])
        acoustic = ctc_acoustic.AcousticModel.__new__(ctc_acoustic.AcousticModel)
        acoustic.torch = torch
        acoustic.device = torch.device("cpu")
        acoustic.dtype = torch.float32
        acoustic.model = model
        emissions, boundaries = acoustic.encode(np.zeros(1000, dtype="float32"))
        self.assertEqual(calls, [[1000]])
        self.assertEqual(emissions.shape[1], 2)
        self.assertEqual(boundaries, [40, 360])


class Pipeline(unittest.TestCase):
    def test_result_metadata_and_atomic_cache_from_fake_inference(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "alignment" / "section.json"
            (Path(folder) / "book").write_bytes(b"audio")
            def extract(command, *_):
                Path(command[-1]).write_bytes(b"fake wave")
                return 0, ""
            def infer(wave, root, fragments, start, *_):
                wave.unlink()
                self.assertEqual((fragments, start), (["First", "Last"], 8.5))
                return ([{"index": 0, "start": 8.6, "end": 9}, {"index": 1, "start": 9, "end": 10}],
                        {"modelReady": 0.1, "acousticEncoding": 0.2, "ctcPath": 0.3})
            with mock.patch.object(ctc_pipeline, "run_with_deadline", side_effect=extract), mock.patch.object(ctc_pipeline, "_infer", side_effect=infer):
                result = ctc_pipeline.align_ctc_section(audio=Path(folder) / "book", output=output, fragments=["First", "Last"],
                                                        language="eng", start=8.5, duration=20, media_folder=Path(folder))
            self.assertEqual(result["engine"], ctc_acoustic.ENGINE)
            self.assertEqual(result["outcome"], "mapped")
            self.assertEqual(json.loads(output.read_text()), result)
            self.assertEqual([row["index"] for row in result["intervals"]], [0, 1])
            self.assertEqual(set(result["stageTimings"]), {"audioExtraction", "modelReady", "acousticEncoding", "ctcPath"})

    def test_timed_out_resident_work_blocks_next_job_and_never_publishes_late(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "result.json"
            (Path(folder) / "book").write_bytes(b"audio")
            release = threading.Event()
            gate = Gate()
            def extract(command, *_):
                Path(command[-1]).write_bytes(b"fake wave")
                return 0, ""
            def infer(wave, *_):
                try:
                    release.wait(5)
                    return [], {"ctcPath": 0}
                finally:
                    wave.unlink()
            with mock.patch.object(ctc_pipeline, "run_with_deadline", side_effect=extract), mock.patch.object(ctc_pipeline, "_infer", side_effect=infer):
                try:
                    with self.assertRaises(AlignmentTimeout):
                        with gate.hold():
                            ctc_pipeline.align_ctc_section(audio=Path(folder) / "book", output=output, fragments=["One"],
                                language="eng", start=0, duration=1, media_folder=Path(folder),
                                env={"ALIGNMENT_TIMEOUT_BASE_SECONDS": "1", "ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND": "0", "ALIGNMENT_TIMEOUT_MAX_SECONDS": "1"})
                    self.assertTrue(gate.stuck)
                    with self.assertRaises(WorkerBusy):
                        with gate.hold():
                            pass
                finally:
                    release.set()
                for _ in range(100):
                    if not gate.busy:
                        break
                    time.sleep(0.01)
                self.assertFalse(gate.busy)
                self.assertFalse(output.exists())
                self.assertFalse(output.with_suffix(".ctc.wav").exists())


class QualityGate(unittest.TestCase):
    def test_counts_missing_outliers_and_transitions_in_the_full_denominator(self):
        truth = [{"index": i, "start": i * 2, "end": i * 2 + 1} for i in range(128)]
        predictions = [dict(row) for row in truth]
        self.assertTrue(gate_ctc.score(predictions, truth)["passed"])
        predictions.pop(0)
        predictions[8]["end"] += 1.1
        metrics = gate_ctc.score(predictions, truth)
        self.assertFalse(metrics["passed"])
        self.assertEqual(metrics["missing"], 1)
        self.assertEqual(metrics["transitions_covered"], 125)
        self.assertGreater(metrics["max_error_ms"], 1000)
        with self.assertRaises(ValueError):
            gate_ctc.score(predictions + [predictions[-1]], truth)



class PathCellLimitTests(unittest.TestCase):
    def test_default_and_override_are_bounded(self):
        self.assertEqual(ctc_path._max_path_cells({}), 500_000_000)
        self.assertEqual(ctc_path._max_path_cells({"ALIGNMENT_CTC_MAX_PATH_CELLS": "2000000000"}), 2_000_000_000)
        for bad in ("", "abc", "0", "-5", "999999", "99999999999999"):
            self.assertEqual(ctc_path._max_path_cells({"ALIGNMENT_CTC_MAX_PATH_CELLS": bad}), 500_000_000, bad)

if __name__ == "__main__":
    unittest.main()
