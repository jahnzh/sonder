"""Acoustic microbatch: out-of-memory halving and the run configuration a request reports (#276). Model-free."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import ctc_acoustic
import ctc_pipeline
from ctc_acoustic import Microbatch, is_out_of_memory

try:
    import numpy as np
except ImportError:
    np = None


class OutOfMemoryError(RuntimeError):
    """Stands in for torch.cuda.OutOfMemoryError, which the check matches by name."""


class FakeModel:
    """Encodes items as their own label; any group wider than `fits` runs out of memory."""
    def __init__(self, fits, error=OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB")):
        self.fits = fits
        self.error = error
        self.groups = []
        self.released = 0

    def encode_chunks(self, items):
        self.groups.append(len(items))
        if len(items) > self.fits:
            raise self.error
        return [("encoded", item) for item in items]

    def release_memory(self):
        self.released += 1


class Halving(unittest.TestCase):
    def test_out_of_memory_halves_the_microbatch_and_keeps_every_core_in_order(self):
        model = FakeModel(fits=2)
        batch = Microbatch(ctc_acoustic.ACOUSTIC_MICROBATCH)
        items = list(range(7))
        self.assertEqual(batch.encode(model, items), [("encoded", item) for item in items])
        self.assertEqual(model.groups, [4, 2, 2, 2, 1])
        self.assertEqual(model.released, 1)
        self.assertEqual(batch.report(), {"acousticMicrobatch": 4, "acousticMicrobatchUsed": 2, "oomHalvings": 1})

    def test_halved_size_carries_over_to_the_next_flush(self):
        model = FakeModel(fits=1)
        batch = Microbatch(4)
        batch.encode(model, [0, 1, 2, 3])
        model.groups.clear()
        batch.encode(model, [4, 5])
        self.assertEqual(model.groups, [1, 1])
        self.assertEqual(batch.report()["oomHalvings"], 2)

    def test_out_of_memory_at_one_core_and_other_errors_propagate(self):
        with self.assertRaises(OutOfMemoryError):
            Microbatch(1).encode(FakeModel(fits=0), [0])
        model = FakeModel(fits=0, error=ValueError("bad audio"))
        with self.assertRaises(ValueError):
            Microbatch(4).encode(model, [0, 1])
        self.assertEqual(model.groups, [2])

    def test_cpu_and_cuda_allocator_failures_count_as_out_of_memory(self):
        self.assertTrue(is_out_of_memory(OutOfMemoryError("anything")))
        self.assertTrue(is_out_of_memory(RuntimeError("CUDA out of memory.")))
        self.assertTrue(is_out_of_memory(RuntimeError("[enforce fail at alloc_cpu.cpp] DefaultCPUAllocator: can't allocate memory")))
        self.assertTrue(is_out_of_memory(MemoryError()))
        self.assertFalse(is_out_of_memory(RuntimeError("shape mismatch")))


class Configuration(unittest.TestCase):
    def test_defaults_are_named_constants(self):
        self.assertEqual(ctc_acoustic.ACOUSTIC_MICROBATCH, 4)
        self.assertEqual(ctc_acoustic.RESIDENT_MODELS_PER_DEVICE, 1)
        self.assertEqual(ctc_pipeline.CTC_DECODE_WORKERS, 2)
        self.assertEqual(ctc_pipeline.encode_batch_size({}), 4)
        self.assertEqual(ctc_pipeline.encode_batch_size({"ALIGNMENT_CTC_ENCODE_BATCH": "8"}), 8)

    def test_a_halved_microbatch_from_the_server_is_used_but_never_raises_the_configured_one(self):
        self.assertEqual(ctc_pipeline.request_microbatch({}, 2).report(),
                         {"acousticMicrobatch": 4, "acousticMicrobatchUsed": 2, "oomHalvings": 0})
        self.assertEqual(ctc_pipeline.request_microbatch({}, 16).size, 4)
        self.assertEqual(ctc_pipeline.request_microbatch({}, None).size, 4)

    def test_section_result_reports_the_configuration_and_halving_of_its_request(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "alignment" / "section.json"
            (Path(folder) / "book").write_bytes(b"audio")

            def extract(command, *_):
                Path(command[-1]).write_bytes(b"fake wave")
                return 0, ""

            def infer(wave, *arguments):
                wave.unlink()
                batch = arguments[-1]
                batch.encode(FakeModel(fits=1), [0, 1])
                return [{"index": 0, "start": 8.6, "end": 9}], {"acousticEncoding": 0.2}

            with mock.patch.object(ctc_pipeline, "run_with_deadline", side_effect=extract), \
                 mock.patch.object(ctc_pipeline, "_infer", side_effect=infer):
                result = ctc_pipeline.align_ctc_section(
                    audio=Path(folder) / "book", output=output, fragments=["First"], language="eng",
                    start=8.5, duration=20, media_folder=Path(folder), env={"ALIGNMENT_EXTRACT_WORKERS": "3"})
            self.assertEqual(result["runConfig"], {
                "acousticMicrobatch": 4, "acousticMicrobatchUsed": 1, "oomHalvings": 2,
                "decodeWorkers": 2, "extractWorkers": 3, "residentModelsPerDevice": 1})
            self.assertEqual(json.loads(output.read_text())["runConfig"], result["runConfig"])

    def test_pcm_encode_halves_on_out_of_memory_through_the_real_window_loop(self):
        if np is None:
            self.skipTest("numpy is optional outside the worker environment")

        class Joined:
            def __init__(self, value):
                self.value = value

            def contiguous(self):
                return self.value

        class Torch:
            @staticmethod
            def cat(parts, dim):
                return Joined(np.concatenate(parts, axis=dim))

        class Model(FakeModel):
            labels = ("-", "|", "A")
            device = mock.Mock(type="cpu")
            torch = Torch()

            def encode_chunks(self, items):
                self.groups.append(len(items))
                if len(items) > self.fits:
                    raise self.error
                out = []
                for _audio, core_start, core_end, context_start in items:
                    frames = (core_end - core_start) // ctc_acoustic.STRIDE
                    out.append((np.zeros((1, frames, 3), dtype="float32"),
                                [core_start + i * ctc_acoustic.STRIDE for i in range(frames)]))
                return out

        model = Model(fits=1)
        batch = Microbatch(4)
        pcm = np.zeros(ctc_acoustic.CORE * 5, dtype="float32")
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.object(ctc_pipeline.ctc_path, "align", return_value=[]):
            ctc_pipeline._infer_from_pcm(pcm, Path(folder), ["A"], 0, 100, Path(folder) / "book", None,
                                         "recording", "fingerprint", "track", {"ALIGNMENT_CTC_CACHE_BYTES": "0"},
                                         digest="digest", model=model, microbatch=batch)
        self.assertEqual(model.groups[0], 4)
        self.assertEqual(sum(group for group in model.groups if group <= 1), 5)
        self.assertEqual(batch.report(), {"acousticMicrobatch": 4, "acousticMicrobatchUsed": 1, "oomHalvings": 2})


if __name__ == "__main__":
    unittest.main()
