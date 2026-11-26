"""The host's book model (#921): which model a whole-book job encodes with, its engine, SEW-D tiny's labels and
frame grid, and jobs that carry the host's engine. Standard library only, except where a test says so.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import book_job
import ctc_sewd
from book_job import LABELS, BookJobs, request_digest
from book_model import BOOK_ENGINES, SEW_D_TINY, WAV2VEC2_BASE, book_engine, book_model_name
from book_session import DiskBudget, SessionRegistry

try:
    import numpy
except ImportError:  # pragma: no cover - the server's test Python has no numpy
    numpy = None
try:
    import torch
except ImportError:  # pragma: no cover - the server's test Python has no torch
    torch = None

# The pinned checkpoint's feature extractor and vocabulary (config.json and vocab.json at ctc_sewd.REVISION).
SEWD_KERNELS = [10, 3, 1, 3, 1, 3, 1, 3, 1, 2, 1, 2, 1]
SEWD_STRIDES = [5, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1]
SEWD_VOCAB = {"<s>": 1, "<pad>": 0, "</s>": 2, "<unk>": 3, "|": 4, "E": 5, "T": 6, "A": 7, "O": 8, "N": 9, "I": 10,
              "H": 11, "S": 12, "R": 13, "D": 14, "L": 15, "U": 16, "M": 17, "W": 18, "C": 19, "F": 20, "G": 21,
              "Y": 22, "P": 23, "B": 24, "V": 25, "K": 26, "'": 27, "X": 28, "J": 29, "Q": 30, "Z": 31}


class ModelChoice(unittest.TestCase):
    def test_a_gpu_host_keeps_base_and_a_cpu_host_takes_sew_d_tiny(self):
        self.assertEqual(book_model_name({"ALIGNMENT_CTC_DEVICE": "cuda"}), WAV2VEC2_BASE)
        self.assertEqual(book_model_name({"ALIGNMENT_CTC_DEVICE": "cuda:0"}), WAV2VEC2_BASE)
        self.assertEqual(book_model_name({"ALIGNMENT_CTC_DEVICE": "cpu"}), SEW_D_TINY)
        self.assertEqual(book_model_name({}), SEW_D_TINY, "the worker's device defaults to cpu")

    def test_the_host_setting_overrides_the_device(self):
        self.assertEqual(book_model_name({"ALIGNMENT_CTC_DEVICE": "cpu", "ALIGNMENT_BOOK_MODEL": "wav2vec2-base"}),
                         WAV2VEC2_BASE)
        self.assertEqual(book_model_name({"ALIGNMENT_CTC_DEVICE": "cuda", "ALIGNMENT_BOOK_MODEL": " SEW-D-tiny "}),
                         SEW_D_TINY)
        self.assertEqual(book_model_name({"ALIGNMENT_CTC_DEVICE": "cuda", "ALIGNMENT_BOOK_MODEL": ""}), WAV2VEC2_BASE)

    def test_an_unknown_model_is_refused(self):
        with self.assertRaisesRegex(ValueError, "ALIGNMENT_BOOK_MODEL must be one of"):
            book_model_name({"ALIGNMENT_BOOK_MODEL": "sewd"})

    def test_each_model_has_its_own_book_engine(self):
        self.assertEqual(book_engine(WAV2VEC2_BASE), book_job.BOOK_ENGINE)
        self.assertEqual(book_engine(WAV2VEC2_BASE), "ctc-wav2vec2-base-960h-torchaudio-2.8-book-v2")
        self.assertNotEqual(book_engine(SEW_D_TINY), book_engine(WAV2VEC2_BASE))
        self.assertTrue(all(engine.endswith("-book-v2") for engine in BOOK_ENGINES.values()))
        self.assertIn(ctc_sewd.TRANSFORMERS_VERSION.rsplit(".", 1)[0], book_engine(SEW_D_TINY))


class SewdGridAndLabels(unittest.TestCase):
    def test_the_pinned_feature_extractor_has_the_book_aligners_grid(self):
        grid = ctc_sewd.frame_grid({"conv_kernel": SEWD_KERNELS, "conv_stride": SEWD_STRIDES})
        self.assertEqual(grid, (320, 400))
        self.assertEqual(grid, (ctc_sewd.STRIDE, ctc_sewd.RECEPTIVE_FIELD))
        # Wav2Vec2 Base's seven convolutions: the same grid.
        self.assertEqual(ctc_sewd.frame_grid({"conv_kernel": [10, 3, 3, 3, 3, 2, 2],
                                              "conv_stride": [5, 2, 2, 2, 2, 2, 2]}), (320, 400))
        # Another stride is another grid, which the load refuses.
        self.assertNotEqual(ctc_sewd.frame_grid({"conv_kernel": SEWD_KERNELS[:-2], "conv_stride": SEWD_STRIDES[:-2]}),
                            (320, 400))

    @unittest.skipUnless(numpy is not None, "numpy is optional outside the worker environment")
    def test_book_align_converts_frames_on_that_grid(self):
        import book_align
        # Half a stride before frame i's centre (200 + 320 i): the same as ctc_acoustic.frame_boundary.
        import ctc_acoustic
        for frame in (0, 1, 1000):
            self.assertEqual(book_align.frame_boundary(frame), ctc_acoustic.frame_boundary(0, frame))
            self.assertEqual(book_align.frame_boundary(frame), 40 + 320 * frame)

    def test_labels_map_to_the_emissions_classes_blank_first(self):
        indices = ctc_sewd.label_indices(SEWD_VOCAB, LABELS, "<pad>")
        self.assertEqual(len(indices), 29)
        self.assertEqual(indices[0], 0, "the blank is <pad>")
        self.assertEqual(indices[LABELS.index("|")], 4)
        self.assertEqual(indices[LABELS.index("'")], 27)
        self.assertEqual(indices[LABELS.index("Z")], 31)
        self.assertEqual([LABELS[i] for i in range(1, 29)], [{v: k for k, v in SEWD_VOCAB.items()}[x]
                                                              for x in indices[1:]])
        self.assertNotIn(SEWD_VOCAB["<s>"], indices)
        self.assertNotIn(SEWD_VOCAB["<unk>"], indices)

    def test_a_vocabulary_without_a_label_is_refused(self):
        vocab = {k: v for k, v in SEWD_VOCAB.items() if k != "Q"}
        with self.assertRaisesRegex(ValueError, "no 'Q'"):
            ctc_sewd.label_indices(vocab, LABELS, "<pad>")

    def test_files_are_pinned_and_checked(self):
        self.assertEqual(set(ctc_sewd.FILES), {"config.json", "preprocessor_config.json", "vocab.json", "model.safetensors"})
        self.assertTrue(all(len(digest) == 64 for digest in ctc_sewd.FILES.values()))
        self.assertIn(ctc_sewd.REVISION, ctc_sewd.file_url("model.safetensors"))
        with tempfile.TemporaryDirectory() as folder:
            self.assertFalse(ctc_sewd.files_present(folder))
            path = Path(folder) / "vocab.json"
            path.write_text(json.dumps(SEWD_VOCAB, indent=1))  # not the pinned bytes
            with self.assertRaisesRegex(ValueError, "does not match the pinned model"):
                ctc_sewd.verify_file(path, "vocab.json")


class Stages:
    """The fewest stages that finish: a result with the stages' engine, as WorkerStages writes it."""

    def __init__(self, engine):
        self.engine = engine

    def run(self, job, session, should_stop):
        book_job.write_json(job.folder / "result.json",
                            {"jobId": job.key, "engine": self.engine, "outcome": "unsynced", "intervals": []})

    def encode_position(self, key):
        return None


def request():
    return {"jobId": "job-1", "recordingId": "r1", "language": "eng",
            "sentences": [{"id": "p0", "section": 0, "text": "Hello there."}],
            "tracks": [{"id": "t0", "audio": "/media/t0.mp3", "duration": 60.0}]}


class JobsCarryTheHostsEngine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "book-jobs"

    def tearDown(self):
        self.tmp.cleanup()

    def jobs(self, engine):
        return BookJobs(self.root, Stages(engine), SessionRegistry(DiskBudget(10 ** 6), idle=900), state_bytes=1024)

    def test_a_sew_d_host_names_its_engine_in_progress_cancel_and_result(self):
        engine = book_engine(SEW_D_TINY)
        jobs = self.jobs(engine)
        self.assertEqual(jobs.engine, engine)
        self.assertEqual(jobs.start(request())["engine"], engine)
        for _ in range(500):
            if jobs.status("job-1")["state"] == "done":
                break
            import time
            time.sleep(0.01)
        self.assertEqual(jobs.result("job-1")["engine"], engine)
        jobs.shutdown()

    def test_a_retained_folder_of_the_other_models_engine_starts_over(self):
        folder = self.root / "job-1"
        (folder / "emissions").mkdir(parents=True)
        (folder / "emissions" / "0.f16").write_bytes(b"\0" * 58)
        (folder / "request.json").write_text(json.dumps(request()))
        (folder / "state.json").write_text(json.dumps({
            "jobId": "job-1", "engine": book_engine(WAV2VEC2_BASE), "digest": request_digest(request()),
            "state": "aligning", "createdAt": 1.0, "updatedAt": 1.0, "progress": {}, "stageTimings": {},
            "error": None, "resumed": 0}))
        jobs = self.jobs(book_engine(SEW_D_TINY))
        jobs.resume_all()
        self.assertFalse((folder / "emissions").exists(), "Base's emissions are not reused by SEW-D tiny")
        self.assertEqual(jobs.status("job-1")["engine"], book_engine(SEW_D_TINY))
        jobs.shutdown()

    def test_stages_without_an_engine_keep_bases(self):
        class Old:
            def run(self, job, session, should_stop):
                pass
        self.assertEqual(BookJobs(self.root, Old()).engine, book_job.BOOK_ENGINE)


try:
    import fastapi  # noqa: F401
except ImportError:  # pragma: no cover
    fastapi = None


@unittest.skipUnless(fastapi is not None, "fastapi is not installed")
class HealthNamesTheHostsModel(unittest.TestCase):
    def health(self, env):
        import os
        from unittest import mock
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.dict(os.environ, {"MEDIA_ROOT": folder, "ALIGNMENT_WORKER_TOKEN": "t", **env}):
            for name in ("ALIGNMENT_BOOK_MODEL", "ALIGNMENT_CTC_DEVICE"):
                if name not in env:
                    os.environ.pop(name, None)
            sys.modules.pop("align", None)
            try:
                import align
                return align.health()["bookJobs"], align.BOOK_MODEL
            finally:
                sys.modules.pop("align", None)

    def test_a_cpu_host_reports_sew_d_tiny_and_a_gpu_host_base(self):
        book, model = self.health({"ALIGNMENT_CTC_DEVICE": "cpu"})
        self.assertEqual((model, book["model"], book["engine"]), (SEW_D_TINY, SEW_D_TINY, book_engine(SEW_D_TINY)))
        self.assertFalse(book["ready"], "no weights in an empty media root")
        book, model = self.health({"ALIGNMENT_CTC_DEVICE": "cuda"})
        self.assertEqual((book["model"], book["engine"]), (WAV2VEC2_BASE, book_engine(WAV2VEC2_BASE)))
        book, _ = self.health({"ALIGNMENT_CTC_DEVICE": "cpu", "ALIGNMENT_BOOK_MODEL": "wav2vec2-base"})
        self.assertEqual(book["engine"], book_engine(WAV2VEC2_BASE))

    def test_an_unknown_book_model_stops_the_worker_at_import(self):
        with self.assertRaisesRegex(ValueError, "ALIGNMENT_BOOK_MODEL"):
            self.health({"ALIGNMENT_BOOK_MODEL": "tiny"})


@unittest.skipUnless(torch is not None, "torch and numpy are optional outside the worker environment")
class EncodeChecksTheGrid(unittest.TestCase):
    def test_a_model_with_another_frame_count_is_refused(self):
        import numpy as np
        import book_encode

        class HalfGrid:
            """A model on a 640-sample grid: every frame would land at the wrong time."""
            def __init__(self):
                self.torch, self.device, self.dtype = torch, torch.device("cpu"), torch.float32

            def model(self, wave):
                return torch.zeros(wave.shape[0], (wave.shape[1] - 400) // 640 + 1, 29), None

        with tempfile.TemporaryDirectory() as folder:
            pcm = Path(folder) / "t.pcm"
            np.zeros(16000 * 30, dtype="<i2").tofile(pcm)
            track = {"index": 0, "pcm": str(pcm), "samples": 16000 * 30}
            with self.assertRaisesRegex(RuntimeError, "frames for a window of"):
                book_encode.encode_tracks(HalfGrid(), [track], Path(folder) / "em", None, batch_size=1)


@unittest.skipUnless(torch is not None and ctc_sewd.transformers_ready() and
                     ctc_sewd.files_present(Path(__import__("os").environ.get("SONDER_SEWD_ALIGNMENT", "/nonexistent"))),
                     "transformers and the SEW-D tiny weights (SONDER_SEWD_ALIGNMENT=<MEDIA_ROOT>/alignment) are needed")
class RealSewd(unittest.TestCase):
    def test_the_pinned_model_loads_and_gives_29_classes_on_the_grid(self):
        import os
        model = ctc_sewd.SewdModel(Path(os.environ["SONDER_SEWD_ALIGNMENT"]), "cpu")
        wave = torch.randn(2, 16000 * 30) * 0.1
        with torch.inference_mode():
            logits, _ = model.model(wave)
        self.assertEqual(tuple(logits.shape), (2, (16000 * 30 - 400) // 320 + 1, 29))
        self.assertLess(model.parameters, 30_000_000)


if __name__ == "__main__":
    unittest.main()
