"""The real whole-book stages (#402) with a fake acoustic model: decode with ffmpeg on the container
timeline and by time range, the per-track duration check, one encode per device, per-track emissions,
resume after a worker restart, and the HTTP endpoints.

Needs numpy, torch and ffmpeg (the worker's environment); skipped where they are missing.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
try:
    import numpy as np
    import torch
except ImportError:  # pragma: no cover - the server's test Python has neither
    np = torch = None
FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
READY = np is not None and torch is not None and FFMPEG

if READY:
    import book_align
    import book_audio
    import book_encode
    from book_job import BOOK_ENGINE, BookJobs, WorkerStages
    from book_session import DiskBudget, SessionRegistry


def write_wav(path, seconds, rate=16000, seed=0):
    """A WAV whose samples encode their own position, so a misplaced range shows."""
    count = int(seconds * rate)
    rng = np.random.default_rng(seed)
    samples = (np.sin(np.arange(count) * 0.05) * 8000 + rng.normal(0, 2000, count)).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(samples.tobytes())
    return samples


class FakeModel:
    """Stands in for ctc_acoustic.AcousticModel: random log-probabilities on the wav2vec2 frame grid."""

    def __init__(self):
        self.torch = torch
        self.device = torch.device("cpu")
        self.dtype = torch.float32
        self.calls = 0
        self.windows = 0

    def model(self, wave):
        self.calls += 1
        self.windows += wave.shape[0]
        frames = (wave.shape[1] - 400) // 320 + 1
        generator = torch.Generator().manual_seed(int(wave.shape[1]))
        return torch.randn(wave.shape[0], frames, 29, generator=generator), None


class ContentModel(FakeModel):
    """Like FakeModel, but each window's log-probabilities follow from its samples, not only its length."""

    def model(self, wave):
        import zlib
        self.calls += 1
        self.windows += wave.shape[0]
        frames = (wave.shape[1] - 400) // 320 + 1
        rows = []
        for row in wave:
            seed = zlib.crc32(row.numpy().tobytes())
            rows.append(torch.randn(frames, 29, generator=torch.Generator().manual_seed(seed)))
        return torch.stack(rows), None


def emissions_digest(longform, task):
    import zlib
    return zlib.crc32(np.ascontiguousarray(longform.em[task["aStart"]:task["aEnd"]]).tobytes())


@unittest.skipUnless(READY, "numpy, torch and ffmpeg are needed")
class Decode(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_ranges_join_to_the_whole_track_exactly(self):
        samples = write_wav(self.dir / "a.wav", 47.3)
        metas, _ = book_audio.decode_tracks([{"index": 0, "audio": self.dir / "a.wav"}], self.dir / "out",
                                            workers=4, range_seconds=10)
        self.assertEqual(metas[0]["ranges"], 5)
        decoded = np.fromfile(self.dir / "out" / "0.pcm", dtype="<i2")
        self.assertEqual(len(decoded), len(samples))
        np.testing.assert_array_equal(decoded, samples)
        self.assertEqual(sorted(p.name for p in (self.dir / "out").iterdir()), ["0.pcm"])

    def test_duration_check_per_track(self):
        write_wav(self.dir / "a.wav", 12.0)
        write_wav(self.dir / "b.wav", 30.0, rate=44100)
        metas, _ = book_audio.decode_tracks([{"index": 0, "audio": self.dir / "a.wav"},
                                             {"index": 1, "audio": self.dir / "b.wav"}], self.dir / "out", workers=2)
        for meta, seconds in zip(metas, (12.0, 30.0)):
            check = meta["durationCheck"]
            self.assertAlmostEqual(check["containerSeconds"], seconds, places=2)
            self.assertLessEqual(abs(check["differenceSeconds"]), 0.01)
            self.assertTrue(check["ok"])
            self.assertEqual(meta["method"], "container-time")
        self.assertFalse(book_audio.duration_check(36460.25, 36458.95)["ok"])
        self.assertTrue(book_audio.duration_check(36458.97, 36458.95)["ok"])

    def test_container_timeline_drops_samples_where_timestamps_overlap(self):
        # Two 10 s AAC files joined with the concat demuxer declaring the first as 9.5 s long: the muxer
        # bumps the overlapping timestamps by one tick each, the pattern of The Left Hand of Darkness at its
        # chapter joins. Counted in samples the track is 20.0 s long; its timeline is 19.5 s.
        for name, seed in (("a", 1), ("b", 2)):
            write_wav(self.dir / f"{name}.wav", 10.0, rate=44100, seed=seed)
            code, _, error = book_audio.run_process(["ffmpeg", "-v", "error", "-i", str(self.dir / f"{name}.wav"),
                                                     "-c:a", "aac", "-y", str(self.dir / f"{name}.m4a")])
            self.assertEqual(code, 0, error)
        (self.dir / "list.txt").write_text("file a.m4a\nduration 9.5\nfile b.m4a\n")
        joined = self.dir / "joined.m4a"
        code, _, error = book_audio.run_process(["ffmpeg", "-v", "error", "-f", "concat", "-safe", "0", "-i",
                                                 str(self.dir / "list.txt"), "-c", "copy", "-y", str(joined)])
        self.assertEqual(code, 0, error)
        plain = self.dir / "plain.pcm"
        book_audio.run_process(["ffmpeg", "-v", "error", "-i", str(joined), "-ac", "1", "-ar", "16000",
                                "-f", "s16le", "-y", str(plain)])
        metas, _ = book_audio.decode_tracks([{"index": 0, "audio": joined}], self.dir / "out", workers=1)
        container = metas[0]["samples"] / 16000
        by_count = plain.stat().st_size / 32000
        self.assertGreater(by_count - container, 0.4, (by_count, container))
        self.assertTrue(metas[0]["durationCheck"]["ok"], metas[0]["durationCheck"])
        self.assertFalse(book_audio.duration_check(by_count, metas[0]["durationCheck"]["containerSeconds"])["ok"])


@unittest.skipUnless(READY, "numpy, torch and ffmpeg are needed")
class Encode(unittest.TestCase):
    def test_one_encode_per_device_in_arrival_order(self):
        queue = book_encode.EncodeQueue()
        order, inside = [], []
        release = threading.Event()

        def job(key):
            with queue.hold(key, poll=0.01):
                inside.append(key)
                order.append(key)
                if key == "a":
                    release.wait(5)
                inside.remove(key)

        first = threading.Thread(target=job, args=("a",))
        first.start()
        while queue.position("a") != 0:
            time.sleep(0.01)
        threads = []
        for key in ("b", "c"):
            threads.append(threading.Thread(target=job, args=(key,)))
            threads[-1].start()
            while queue.position(key) is None:
                time.sleep(0.01)
        self.assertEqual((queue.position("b"), queue.position("c")), (1, 2))
        release.set()
        for thread in [first, *threads]:
            thread.join(5)
        self.assertEqual(order, ["a", "b", "c"])
        self.assertIs(book_encode.encode_queue("cuda"), book_encode.encode_queue("cuda:0"))

    def test_waiting_for_the_encoder_can_be_cancelled(self):
        queue = book_encode.EncodeQueue()
        stop = threading.Event()
        with queue.hold("a"):
            errors = []

            def wait():
                try:
                    with queue.hold("b", stop.is_set, poll=0.01):
                        pass
                except book_encode.EncodeCancelled as error:
                    errors.append(error)

            thread = threading.Thread(target=wait)
            thread.start()
            stop.set()
            thread.join(5)
            self.assertEqual(len(errors), 1)
            self.assertIsNone(queue.position("b"))

    def test_per_track_emissions_on_each_tracks_grid(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            tracks = []
            for index, seconds in enumerate((31.7, 4.2, 55.0)):
                pcm = folder / f"{index}.pcm"
                (np.zeros(int(seconds * 16000), "<i2")).tofile(pcm)
                tracks.append({"index": index, "pcm": str(pcm), "samples": int(seconds * 16000),
                               "identity": {"engine": BOOK_ENGINE, "sha256": str(index)}})
            model = FakeModel()
            seen = []
            book_encode.encode_tracks(model, tracks, folder / "em", None, batch_size=8, on_track=seen.append)
            self.assertEqual([info["index"] for info in seen], [0, 1, 2])
            for track in tracks:
                frames = book_encode.complete_emissions(folder / "em", track["index"], track["identity"])
                # Every frame whose 400-sample receptive field lies inside the track, window by window.
                self.assertEqual(frames, (track["samples"] - 400) // 320 + 1)
                self.assertIsNone(book_encode.complete_emissions(folder / "em", track["index"], {"engine": "other"}))


@unittest.skipUnless(READY, "numpy, torch and ffmpeg are needed")
class Pipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.media = self.dir / "media"
        (self.media / "staged").mkdir(parents=True)
        self.tracks = []
        for index, seconds in enumerate((40.0, 25.0)):
            path = self.media / "staged" / f"t{index}.wav"
            write_wav(path, seconds, seed=index)
            self.tracks.append({"id": f"t{index}", "audio": str(path), "duration": seconds})
        self.request = {"jobId": "book-1", "recordingId": "recording-1", "audioFingerprint": "fp",
                        "language": "eng", "tracks": self.tracks,
                        "sentences": [{"id": f"p{k}", "section": 0, "text": f"Sentence number {k} here."}
                                      for k in range(20)]}
        self.env = {"ALIGNMENT_BOOK_ALIGN_WORKERS": "1"}

    def tearDown(self):
        self.tmp.cleanup()

    def jobs(self, model):
        stages = WorkerStages(self.media / "alignment", lambda: model, "cpu", env=self.env)
        registry = SessionRegistry(DiskBudget(10 ** 9), idle=900)
        return BookJobs(self.media / "alignment" / "book-jobs", stages, registry)

    @staticmethod
    def wait(jobs, key="book-1", states=("done", "failed", "cancelled")):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if jobs.status(key)["state"] in states:
                return jobs.status(key)
            time.sleep(0.05)
        raise AssertionError(jobs.status(key))

    def plan(self, frames):
        third = frames // 3
        return book_align.group_tasks([(0, 0), (third, 5), (2 * third, 12)], frames), {"groups": 3}

    def test_a_job_runs_to_a_result_in_the_interval_shape(self):
        model = FakeModel()
        jobs = self.jobs(model)
        with mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                               self.plan(longform.em.shape[0])):
            jobs.start(self.request)
            status = self.wait(jobs)
        self.assertEqual(status["state"], "done", status)
        self.assertEqual(status["progress"]["groupsDone"], 3)
        self.assertEqual(status["progress"]["tracksEncoded"], 2)
        result = jobs.result("book-1")
        self.assertEqual(result["engine"], BOOK_ENGINE)
        self.assertEqual(result["outcome"], "unsynced")  # random emissions map nothing
        self.assertEqual([t["id"] for t in result["tracks"]], ["t0", "t1"])
        for row, track in zip(result["tracks"], self.tracks):
            self.assertTrue(row["durationOk"])
            self.assertAlmostEqual(row["decodedSeconds"], track["duration"], places=2)
        self.assertIn("encode", result["stageTimings"])
        # Fetching ends the session: decoded audio and emissions are deleted.
        folder = self.media / "alignment" / "book-jobs" / "book-1"
        self.assertFalse((folder / "emissions").exists())
        self.assertFalse((folder / "tracks").exists())

    def test_resume_after_a_restart_reuses_emissions_and_finished_groups(self):
        first_model = FakeModel()
        jobs = self.jobs(first_model)
        aligned = []
        real = book_align.align_group

        def align_then_stop(longform, task, should_stop=None):
            aligned.append(task["index"])
            result = real(longform, task, should_stop)
            if task["index"] == 1:  # the worker stops right after group 1 has finished
                jobs._stop(jobs._job("book-1"), "worker stop")
            return result

        with mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                               self.plan(longform.em.shape[0])), \
                mock.patch.object(book_align, "align_group", align_then_stop):
            jobs.start(self.request)
            jobs._job("book-1").thread.join(30)
            jobs.shutdown()
        folder = self.media / "alignment" / "book-jobs" / "book-1"
        self.assertEqual(aligned, [0, 1])
        self.assertTrue((folder / "groups" / "1.json").is_file())
        self.assertFalse((folder / "groups" / "2.json").exists())
        self.assertTrue((folder / "emissions" / "0.f16").is_file())
        self.assertFalse(any((folder / "tracks").glob("*.pcm")), "PCM goes once a track is encoded")
        encoded = first_model.windows
        self.assertGreater(encoded, 0)

        second_model = FakeModel()
        restarted = self.jobs(second_model)
        aligned.clear()

        def align_recorded(longform, task, should_stop=None):
            aligned.append(task["index"])
            return real(longform, task, should_stop)

        planned = []
        with mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                               planned.append(1) or self.plan(longform.em.shape[0])), \
                mock.patch.object(book_align, "align_group", align_recorded):
            self.assertEqual(restarted.resume_all(), ["book-1"])
            status = self.wait(restarted)
        self.assertEqual(status["state"], "done", status)
        self.assertEqual(status["resumed"], 1)
        self.assertEqual(second_model.windows, 0, "finished tracks are not encoded again")
        self.assertEqual(planned, [], "the stored plan is reused")
        self.assertEqual(aligned, [2], "finished groups are not aligned again")

    def test_a_changed_track_is_decoded_and_encoded_again(self):
        model = FakeModel()
        jobs = self.jobs(model)
        with mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                               self.plan(longform.em.shape[0])):
            jobs.start(self.request)
            self.wait(jobs)
            jobs.shutdown()
            # Same request, different bytes in track 1 (a re-staged copy): its emissions are stale.
            folder = self.media / "alignment" / "book-jobs" / "book-1"
            state = json.loads((folder / "state.json").read_text())
            state["state"] = "aligning"
            (folder / "state.json").write_text(json.dumps(state))
            (folder / "result.json").unlink()
            write_wav(Path(self.tracks[1]["audio"]), 25.0, seed=9)
            second = FakeModel()
            restarted = self.jobs(second)
            restarted.resume_all()
            self.assertEqual(self.wait(restarted)["state"], "done")
        self.assertGreater(second.windows, 0)
        self.assertLess(second.windows, model.windows, "only the changed track is encoded again")

    def test_a_track_replaced_while_stopped_gives_a_result_from_the_new_audio(self):
        # Review round 1: the same request, track 1 replaced by different audio of the same duration while the
        # worker is stopped after group 1. The concatenated emissions, the plan and groups 0 and 1 are stale.
        real = book_align.align_group

        def recording(stop_after=None, jobs_ref=None, key="book-1"):
            def align(longform, task, should_stop=None):
                kept, stats, trimmed = real(longform, task, should_stop)
                stats = dict(stats, emissionsDigest=emissions_digest(longform, task))
                if stop_after is not None and task["index"] == stop_after:
                    jobs_ref[0]._stop(jobs_ref[0]._job(key), "worker stop")
                return kept, stats, trimmed
            return align

        plan = mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                 self.plan(longform.em.shape[0]))
        holder = [self.jobs(ContentModel())]
        with plan, mock.patch.object(book_align, "align_group", recording(1, holder)):
            holder[0].start(self.request)
            holder[0]._job("book-1").thread.join(30)
            holder[0].shutdown()
        folder = self.media / "alignment" / "book-jobs" / "book-1"
        self.assertTrue((folder / "groups" / "1.json").is_file())
        self.assertFalse((folder / "groups" / "2.json").exists())
        old_group = json.loads((folder / "groups" / "0.json").read_text())["stats"]["emissionsDigest"]

        write_wav(Path(self.tracks[1]["audio"]), 25.0, seed=9)  # same duration, other samples
        restarted = self.jobs(ContentModel())
        with plan, mock.patch.object(book_align, "align_group", recording()):
            self.assertEqual(restarted.resume_all(), ["book-1"])
            self.assertEqual(self.wait(restarted)["state"], "done")
            resumed = restarted.result("book-1")
            fresh_jobs = self.jobs(ContentModel())
            fresh_jobs.start({**self.request, "jobId": "book-2"})
            self.assertEqual(self.wait(fresh_jobs, "book-2")["state"], "done")
            fresh = fresh_jobs.result("book-2")
        fresh_group = json.loads((self.media / "alignment" / "book-jobs" / "book-2" / "groups" / "0.json")
                                 .read_text())["stats"]["emissionsDigest"]
        self.assertNotEqual(old_group, fresh_group, "the new audio gives other emissions")
        self.assertEqual(resumed["stats"]["emissionsDigest"], fresh["stats"]["emissionsDigest"],
                         "every group of the resumed job was aligned on the new audio's emissions")
        self.assertEqual(resumed["stats"]["groups"], 3)

    def test_cancel_during_the_encode_releases_everything(self):
        model = FakeModel()
        gate = threading.Event()
        entered = threading.Event()
        inner = model.model

        def slow(wave):
            entered.set()
            gate.wait(10)
            return inner(wave)

        model.model = slow
        jobs = self.jobs(model)
        jobs.start(self.request)
        self.assertTrue(entered.wait(30))
        session = jobs.registry.get("book-1")
        cancel = threading.Thread(target=jobs.cancel, args=("book-1",))
        cancel.start()
        time.sleep(0.2)
        gate.set()
        cancel.join(30)
        self.assertEqual(session.ended, "cancelled")
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertFalse((self.media / "alignment" / "book-jobs" / "book-1").exists())
        self.assertIsNone(book_encode.encode_queue("cpu").holder)


@unittest.skipUnless(READY and sys.platform.startswith("linux"), "Linux, numpy, torch and ffmpeg are needed")
class AlignPool(unittest.TestCase):
    def test_align_processes_die_with_the_worker(self):
        import concurrent.futures
        import multiprocessing
        import signal
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "book.f16"
            np.zeros((100, 29), np.float16).tofile(path)
            with concurrent.futures.ProcessPoolExecutor(
                    max_workers=1, mp_context=multiprocessing.get_context("spawn"), initializer=book_align.pool_init,
                    initargs=(str(path), 29, book_align_labels(), ["Hello."], None, os.getpid())) as pool:
                self.assertEqual(pool.submit(book_align.death_signal).result(timeout=60), signal.SIGKILL)


def book_align_labels():
    from book_job import LABELS
    return LABELS


try:
    from fastapi.testclient import TestClient
except Exception:  # pragma: no cover - fastapi or httpx missing
    TestClient = None


@unittest.skipUnless(READY and TestClient is not None, "numpy, torch, ffmpeg and fastapi's TestClient are needed")
class Endpoints(unittest.TestCase):
    def test_start_status_result_and_cancel_over_http(self):
        with tempfile.TemporaryDirectory() as folder:
            media = Path(folder)
            (media / "staged").mkdir()
            write_wav(media / "staged" / "t0.wav", 20.0)
            env = {"MEDIA_ROOT": str(media), "ALIGNMENT_WORKER_TOKEN": "secret",
                   "ALIGNMENT_BOOK_ALIGN_WORKERS": "1"}
            with mock.patch.dict(os.environ, env):
                sys.modules.pop("align", None)
                import align
                model = FakeModel()
                align.book_jobs.stages.model_loader = lambda: model
                client = TestClient(align.app)
                body = {"jobId": "http-1", "recordingId": "r1", "language": "eng",
                        "sentences": [{"id": "p0", "text": "Hello there friend."}],
                        "tracks": [{"id": "t0", "audio": str(media / "staged" / "t0.wav"), "duration": 20.0}]}
                self.assertEqual(client.post("/book-jobs", json=body).status_code, 401)
                auth = {"Authorization": "Bearer secret"}
                outside = {**body, "tracks": [{"id": "t0", "audio": "/etc/passwd", "duration": 1.0}]}
                self.assertEqual(client.post("/book-jobs", json=outside, headers=auth).status_code, 400)
                started = client.post("/book-jobs", json=body, headers=auth)
                self.assertEqual(started.status_code, 202, started.text)
                self.assertEqual(started.json()["engine"], align.BOOK_ENGINE)
                self.assertNotEqual(align.BOOK_ENGINE, align.CTC_ENGINE)
                deadline = time.monotonic() + 60
                while client.get("/book-jobs/http-1", headers=auth).json()["state"] != "done":
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.05)
                result = client.get("/book-jobs/http-1/result", headers=auth)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json()["engine"], align.BOOK_ENGINE)
                conflict = client.post("/book-jobs", json={**body, "recordingId": "r2"}, headers=auth)
                self.assertEqual(conflict.status_code, 409)
                self.assertEqual(client.delete("/book-jobs/http-1", headers=auth).json()["state"], "cancelled")
                self.assertEqual(client.get("/book-jobs/http-1", headers=auth).status_code, 404)
                self.assertEqual(client.get("/book-jobs/missing/result", headers=auth).status_code, 404)
                self.assertEqual(client.get("/health").json()["bookJobs"]["engine"], align.BOOK_ENGINE)
                align.book_jobs.shutdown()
                sys.modules.pop("align", None)


if __name__ == "__main__":
    unittest.main()
