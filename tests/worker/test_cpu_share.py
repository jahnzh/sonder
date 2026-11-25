"""The thread rule of a whole-book encode on the CPU (#913): alone it uses every core, and from the next batch
on it leaves the cores another book's decode or align holds; window requests keep their own share.

The CpuShare tests are plain Python; the rest need numpy and torch (the worker's environment) and are skipped
where they are missing.
"""
import os
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import cpu_share
from cpu_share import CpuShare

try:
    import numpy as np
    import torch
except ImportError:  # pragma: no cover - the server's test Python has neither
    np = torch = None

if torch is not None:
    import book_align
    import book_encode
    import ctc_acoustic
    from test_book_pipeline import READY, FakeModel, PipelineFixture
    from book_job import BookJobs, WorkerStages
    from book_session import DiskBudget, SessionRegistry
else:
    READY, PipelineFixture = False, unittest.TestCase


class Share(unittest.TestCase):
    def test_alone_every_core_is_free(self):
        self.assertEqual(CpuShare(cores=20).free(), 20)

    def test_claims_take_their_cores_while_they_run(self):
        share = CpuShare(cores=20)
        with share.claim(8):
            self.assertEqual(share.free(), 12)
            with share.claim(1):
                self.assertEqual(share.free(), 11)
            self.assertEqual(share.free(), 12)
        self.assertEqual(share.free(), 20)

    def test_a_claim_ends_when_its_block_fails(self):
        share = CpuShare(cores=4)
        with self.assertRaises(RuntimeError):
            with share.claim(3):
                raise RuntimeError("decode failed")
        self.assertEqual(share.free(), 4)

    def test_at_least_one_core_is_left(self):
        share = CpuShare(cores=4)
        with share.claim(8):
            self.assertEqual(share.free(), 1)

    def test_the_host_cores_are_the_affinity_mask(self):
        with mock.patch.object(os, "sched_getaffinity", lambda pid: {0, 1, 2}, create=True):
            self.assertEqual(cpu_share.host_cores(), 3)
            self.assertEqual(CpuShare().free(), 3)


@unittest.skipUnless(torch is not None, "torch and numpy are optional outside the worker environment")
class TorchThreads(unittest.TestCase):
    def setUp(self):
        before = torch.get_num_threads()
        self.addCleanup(torch.set_num_threads, before)

    def test_the_thread_count_belongs_to_the_calling_thread(self):
        # What the rule relies on: an encode thread's count does not change a window thread's, nor back.
        seen = {}
        set_both = threading.Barrier(2)

        def run(name, count):
            ctc_acoustic.use_cpu_threads(torch, count)
            set_both.wait()
            torch.ones(64, 64) @ torch.ones(64, 64)
            seen[name] = torch.get_num_threads()

        threads = [threading.Thread(target=run, args=("encode", 3)), threading.Thread(target=run, args=("window", 2))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(seen, {"encode": 3, "window": 2})


class CountingModel:
    """Stands in for ctc_acoustic.AcousticModel; records the torch threads of each batch's forward pass."""

    def __init__(self, on_batch=None):
        self.torch = torch
        self.device = torch.device("cpu")
        self.dtype = torch.float32
        self.threads = []
        self.on_batch = on_batch

    def model(self, wave):
        self.threads.append(torch.get_num_threads())
        if self.on_batch is not None:
            self.on_batch(len(self.threads))
        frames = (wave.shape[1] - 400) // 320 + 1
        return torch.zeros(wave.shape[0], frames, 29), None


@unittest.skipUnless(torch is not None, "torch and numpy are optional outside the worker environment")
class EncodeThreads(unittest.TestCase):
    def setUp(self):
        before = torch.get_num_threads()
        self.addCleanup(torch.set_num_threads, before)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        samples = 6 * 20 * 16000  # six 20 s cores: six one-window CPU batches
        pcm = self.folder / "0.pcm"
        np.zeros(samples, "<i2").tofile(pcm)
        self.tracks = [{"index": 0, "pcm": str(pcm), "samples": samples}]

    def encode(self, model, share):
        # In a thread of its own, like a book job's encode.
        stats = {}
        thread = threading.Thread(target=lambda: stats.update(book_encode.encode_tracks(
            model, self.tracks, self.folder / "em", None, batch_size=1, threads=share.free)))
        thread.start()
        thread.join(30)
        return stats

    def test_alone_every_batch_uses_every_core(self):
        model = CountingModel()
        stats = self.encode(model, CpuShare(cores=4))
        self.assertEqual(model.threads, [4] * 6)
        self.assertEqual(stats["threads"], {"min": 4, "max": 4, "last": 4})

    def test_a_second_job_takes_its_cores_from_the_next_batch_and_gives_them_back(self):
        share = CpuShare(cores=4)
        claims = ExitStack()
        self.addCleanup(claims.close)

        def on_batch(count):
            if count == 2:  # another book starts its align pool of three processes during batch 2
                claims.enter_context(share.claim(3))
            if count == 4:  # and ends it during batch 4
                claims.close()

        model = CountingModel(on_batch)
        stats = self.encode(model, share)
        self.assertEqual(model.threads, [4, 4, 1, 1, 4, 4])
        self.assertEqual(stats["threads"], {"min": 1, "max": 4, "last": 4})

    def test_without_a_rule_the_encode_keeps_the_threads_it_has(self):
        model = CountingModel()
        torch.set_num_threads(2)
        stats = book_encode.encode_tracks(model, self.tracks, self.folder / "em", None, batch_size=1)
        self.assertEqual(model.threads, [2] * 6)
        self.assertIsNone(stats["threads"])


class WindowModule:
    """Stands in for the wav2vec2 module behind AcousticModel.encode_chunks."""

    def __init__(self):
        self.threads = []

    def __call__(self, wave, lengths):
        self.threads.append(torch.get_num_threads())
        frames = (wave.shape[1] - 400) // 320 + 1
        return torch.zeros(wave.shape[0], frames, 29), torch.full((wave.shape[0],), frames)


@unittest.skipUnless(torch is not None, "torch and numpy are optional outside the worker environment")
class WindowThreads(unittest.TestCase):
    def setUp(self):
        before = torch.get_num_threads()
        self.addCleanup(torch.set_num_threads, before)
        model = ctc_acoustic.AcousticModel.__new__(ctc_acoustic.AcousticModel)
        model.torch, model.device, model.dtype = torch, torch.device("cpu"), torch.float32
        model.model = WindowModule()
        model.window_threads = None
        self.model = model

    def test_a_window_request_keeps_its_share_after_an_encode_took_every_core(self):
        with mock.patch.object(ctc_acoustic.os, "cpu_count", lambda: 20):
            ctc_acoustic._share_cpu_threads(self.model, {"ALIGNMENT_WORKER_SLOTS": "3"})
        self.assertEqual(self.model.window_threads, 6)
        # A book encode in its own thread set 20 since; a window request in a new thread still runs on 6.
        encode = threading.Thread(target=ctc_acoustic.use_cpu_threads, args=(torch, 20))
        encode.start()
        encode.join()
        audio = np.zeros(30 * 16000, np.float32)
        window = threading.Thread(target=self.model.encode_chunks, args=([(audio, 80000, 400000, 0)],))
        window.start()
        window.join()
        self.assertEqual(self.model.model.threads, [6])

    def test_one_slot_keeps_torchs_own_default(self):
        torch.set_num_threads(5)
        ctc_acoustic._share_cpu_threads(self.model, {"ALIGNMENT_WORKER_SLOTS": "1"})
        self.assertEqual(self.model.window_threads, 5)


class SpyShare(CpuShare):
    def __init__(self, cores):
        super().__init__(cores=cores)
        self.claims = []
        self.asked = []

    def claim(self, cores):
        self.claims.append(cores)
        return super().claim(cores)

    def free(self):
        self.asked.append(super().free())
        return self.asked[-1]


@unittest.skipUnless(READY, "numpy, torch and ffmpeg are needed")
class Stages(PipelineFixture):
    def test_decode_and_align_claim_their_cores_and_the_encode_runs_alone_on_every_core(self):
        self.env["ALIGNMENT_BOOK_DECODE_WORKERS"] = "4"
        share = SpyShare(cores=8)
        stages = WorkerStages(self.media / "alignment", lambda: FakeModel(), "cpu", env=self.env, cpu=share)
        jobs = BookJobs(self.media / "alignment" / "book-jobs", stages, SessionRegistry(DiskBudget(10 ** 9), idle=900))
        before = torch.get_num_threads()
        self.addCleanup(torch.set_num_threads, before)
        with mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                               self.plan(longform.em.shape[0])):
            jobs.start(self.request)
            status = self.wait(jobs)
        self.assertEqual(status["state"], "done", status)
        # Two tracks of one range each: two ffmpeg processes; then the job's thread through the align stage.
        self.assertEqual(share.claims, [2, 1])
        self.assertTrue(share.asked)
        self.assertEqual(set(share.asked), {8})  # the decode's claim ended before the encode
        self.assertEqual(share.claimed(), 0)
        self.assertEqual(jobs.result("book-1")["encode"]["threads"], {"min": 8, "max": 8, "last": 8})


if __name__ == "__main__":
    unittest.main()
