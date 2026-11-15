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
    import book_match
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

    def test_a_track_longer_than_its_container_says_is_stopped_at_its_cap(self):
        # The container claims 10 s; the file holds 60 s. The decoder must not write the 60 s.
        write_wav(self.dir / "a.wav", 60.0)
        sizes = []
        real = book_audio.run_process

        def measured(command, should_stop=None, poll=0.25):
            result = real(command, should_stop, poll)
            sizes.append(Path(command[-1]).stat().st_size)
            return result

        with mock.patch.object(book_audio, "probe_duration", lambda *a, **k: 10.0), \
                mock.patch.object(book_audio, "run_process", measured):
            with self.assertRaises(book_audio.DecodeFailed):
                book_audio.decode_tracks([{"index": 0, "audio": self.dir / "a.wav", "duration": 10.0}],
                                         self.dir / "out", workers=1)
        allowed = (10.0 * 1.10 + 1.0) * 16000 * 2 + (1 << 20)  # ffmpeg's -fs runs past its cap by < 1 MiB
        self.assertTrue(sizes and max(sizes) <= allowed, (sizes, allowed))
        self.assertEqual(list((self.dir / "out").iterdir()), [], "nothing of the failed decode stays")

    def test_the_join_holds_one_range_twice_at_most(self):
        samples = write_wav(self.dir / "a.wav", 40.0)
        pcm = len(samples) * 2
        out = self.dir / "out"
        seen = []
        real_unlink = Path.unlink

        def unlink(path, missing_ok=False):
            if ".part" in path.name and path.exists():  # the moment a joined range is let go
                seen.append(sum(f.stat().st_size for f in out.iterdir()))
            return real_unlink(path, missing_ok=missing_ok)

        with mock.patch.object(Path, "unlink", unlink):
            metas, _ = book_audio.decode_tracks([{"index": 0, "audio": self.dir / "a.wav"}], out, workers=4,
                                                range_seconds=10)
        self.assertEqual(metas[0]["ranges"], 4)
        self.assertTrue(seen)
        self.assertLessEqual(max(seen), pcm + 10 * 16000 * 2 + 1024, "a join held a second copy of the track")
        np.testing.assert_array_equal(np.fromfile(out / "0.pcm", dtype="<i2"), samples)

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


class PipelineFixture(unittest.TestCase):
    """Two staged WAV tracks, a 20-sentence request and BookJobs with the real stages (no tests of its own)."""

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
        # The fake models' random emissions are no book's text: the text-match check (#403) would stop every
        # job before alignment. These tests are about the stages around it, so it passes here;
        # test_a_wrong_book_ends_with_the_mismatch_outcome runs the real check.
        self.match = mock.patch.object(book_match, "check", lambda *a, **k: {"score": None, "matches": True})
        self.match.start()
        self.addCleanup(self.match.stop)

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


@unittest.skipUnless(READY, "numpy, torch and ffmpeg are needed")
class Pipeline(PipelineFixture):
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
        self.assertEqual(result["flags"], [])
        self.assertEqual(len(result["unsyncedPassages"]), 1)
        self.assertEqual(result["stats"]["chainMapped"], 0)
        self.assertIn("leftover", result["stats"])
        self.assertEqual([t["id"] for t in result["tracks"]], ["t0", "t1"])
        for row, track in zip(result["tracks"], self.tracks):
            self.assertTrue(row["durationOk"])
            self.assertAlmostEqual(row["decodedSeconds"], track["duration"], places=2)
        self.assertIn("encode", result["stageTimings"])
        # Fetching ends the session: decoded audio and emissions are deleted.
        folder = self.media / "alignment" / "book-jobs" / "book-1"
        self.assertFalse((folder / "emissions").exists())
        self.assertFalse((folder / "tracks").exists())

    def test_a_wrong_book_ends_with_the_mismatch_outcome(self):
        self.match.stop()  # the real check: random emissions are not this text
        self.request["sections"] = [{"index": 0, "title": "Chapter One"}]
        jobs = self.jobs(FakeModel())
        planned = []
        with mock.patch.object(book_align, "plan_groups", lambda *a, **k: planned.append(1)):
            jobs.start(self.request)
            status = self.wait(jobs)
        self.assertEqual(status["state"], "done", status)
        self.assertEqual(status["outcome"], book_match.TEXT_MISMATCH)
        self.assertEqual(planned, [])  # no alignment ran
        self.assertIn("textMatch", status["stageTimings"])
        result = jobs.result("book-1")
        self.assertEqual(result["outcome"], "text_mismatch")
        self.assertEqual((result["intervals"], result["mapped"], result["flags"]), ([], 0, []))
        self.assertLess(result["textMatch"]["score"], book_match.MATCH_THRESHOLD)
        self.assertEqual(result["textMatch"]["threshold"], book_match.MATCH_THRESHOLD)
        self.assertEqual(result["unsyncedPassages"], [
            {"section": 0, "title": "Chapter One", "firstParagraphId": "p0", "lastParagraphId": "p19",
             "sentenceCount": 20, "excerpt": "Sentence number 0 here."}])
        self.assertEqual([t["id"] for t in result["tracks"]], ["t0", "t1"])

    def long_titled_mismatch(self, budget):
        """A wrong book of 2,000 one-sentence sections, each with a 2,000-character non-ASCII title (align.py's
        limit; six bytes a character as JSON): 2,000 unsynced passages, a result of about 24 MB, more than
        the 16 MiB + 1 KiB a sentence #402 reserved for all of a book's small files (#403 review)."""
        self.match.stop()  # the real check: random emissions are not this text
        sentences = 2000
        self.request["sentences"] = [{"id": f"p{k}", "section": k, "text": f"Sentence number {k} here."}
                                     for k in range(sentences)]
        self.request["sections"] = [{"index": k, "title": "\u00e9" * 2000} for k in range(sentences)]
        stages = WorkerStages(self.media / "alignment", lambda: FakeModel(), "cpu", env=self.env)
        jobs = BookJobs(self.media / "alignment" / "book-jobs", stages,
                        SessionRegistry(DiskBudget(budget), idle=900))
        folder = self.media / "alignment" / "book-jobs" / "book-1"
        peaks, real = [], Path.replace

        def replace(path, target):  # the peak of a write: the old file and its temporary copy are both there
            if folder in Path(path).parents:
                peaks.append((Path(path).name, book_session_folder_bytes(folder), jobs.registry.budget.reserved("book-1")))
            return real(path, target)

        with mock.patch.object(Path, "replace", replace):
            jobs.start(self.request)
            status = self.wait(jobs)
        return jobs, status, peaks, folder

    def test_a_long_titled_mismatch_result_stays_inside_its_reservation(self):
        jobs, status, peaks, folder = self.long_titled_mismatch(10 ** 9)
        self.assertEqual(status["state"], "done", status)
        self.assertEqual(status["outcome"], book_match.TEXT_MISMATCH)
        size = (folder / "result.json").stat().st_size
        from book_session import meta_bytes
        self.assertGreater(size, meta_bytes(2000))
        self.assertTrue(any(name == "result.json.tmp" for name, _, _ in peaks))
        self.assertEqual([p for p in peaks if p[1] > p[2]], [], "the job's files never exceeded its reservation")
        result = jobs.result("book-1")
        self.assertEqual(len(result["unsyncedPassages"]), 2000)
        self.assertEqual(result["unsyncedPassages"][7]["title"], "\u00e9" * 2000)

    def test_a_result_that_does_not_fit_the_budget_fails_the_job_and_is_not_written(self):
        from book_session import meta_bytes
        # Room for every stage before the result (its estimate included), not for the result.
        jobs, status, peaks, folder = self.long_titled_mismatch(meta_bytes(2000) + (4 << 20))
        self.assertEqual(status["state"], "failed", status)
        self.assertIn("result is", status["error"])
        self.assertIn("was not written", status["error"])
        self.assertFalse((folder / "result.json").exists())
        self.assertEqual([p for p in peaks if p[1] > p[2]], [])

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

    def test_the_reservation_covers_tracks_longer_than_declared(self):
        # The request says 1 s per track; the files hold 40 s and 25 s. The reservation must follow the files.
        request = {**self.request, "tracks": [{**t, "duration": 1.0} for t in self.tracks]}
        jobs = self.jobs(FakeModel())
        budget = jobs.registry.budget
        folder = self.media / "alignment" / "book-jobs" / "book-1"
        samples, stop = [], threading.Event()

        def sample():
            while not stop.is_set():
                before = budget.reserved("book-1")
                used = book_session_folder_bytes(folder)
                after = budget.reserved("book-1")
                samples.append((used, max(before, after)))
                time.sleep(0.002)

        sampler = threading.Thread(target=sample)
        sampler.start()
        reserved = []
        real_reserve = budget.reserve
        budget.reserve = lambda key, nbytes: reserved.append(nbytes) or real_reserve(key, nbytes)
        try:
            with mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                   self.plan(longform.em.shape[0])):
                jobs.start(request)
                self.assertEqual(self.wait(jobs)["state"], "done")
        finally:
            stop.set()
            sampler.join(10)
        pcm = (40 + 25) * 16000 * 2
        self.assertGreater(max(reserved), pcm, "reserved from the probed durations, not the request's")
        over = [(used, held) for used, held in samples if used > held]
        self.assertEqual(over, [], "the job's files never exceeded its reservation")

    def test_two_resumed_jobs_with_stale_audio_do_not_wait_for_each_other(self):
        # Two unfinished jobs, each with 50 MiB of PCM left from before a restart, and a 60 MiB budget: their
        # startup claims (100 MiB) exceed it, but the PCM is deleted on resume and what is left fits.
        plan = mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                 self.plan(longform.em.shape[0]))
        root = self.media / "alignment" / "book-jobs"
        with plan:
            jobs = self.jobs(FakeModel())
            for key in ("book-1", "book-2"):
                jobs.start({**self.request, "jobId": key})
                self.assertEqual(self.wait(jobs, key)["state"], "done")
            jobs.shutdown()
            for key in ("book-1", "book-2"):
                state = json.loads((root / key / "state.json").read_text())
                (root / key / "state.json").write_text(json.dumps({**state, "state": "aligning"}))
                (root / key / "result.json").unlink()
                (root / key / "tracks").mkdir(exist_ok=True)
                (root / key / "tracks" / "0.pcm").write_bytes(b"\0" * (50 << 20))
            stages = WorkerStages(self.media / "alignment", lambda: FakeModel(), "cpu", env=self.env)
            restarted = BookJobs(root, stages, SessionRegistry(DiskBudget(60 << 20), idle=900))
            self.assertEqual(sorted(restarted.resume_all()), ["book-1", "book-2"])
            for key in ("book-1", "book-2"):
                self.assertEqual(self.wait(restarted, key)["state"], "done")
        restarted.shutdown()

    def test_two_resumed_jobs_whose_retained_emissions_need_each_others_disk_do_not_wait_forever(self):
        # Round 2 review: each unfinished job keeps its emissions (R bytes) and needs R + its metadata room to
        # go on; the budget holds one of them and half of the other's files. Resumed together, each waited
        # for the other's files forever. Resumed in turn, the older one cannot fit while the other's files
        # wait for it: it fails with a clear error and releases them, and the other finishes.
        from book_session import meta_bytes
        plan = mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                 self.plan(longform.em.shape[0]))
        root = self.media / "alignment" / "book-jobs"
        with plan:
            jobs = self.jobs(FakeModel())
            for created, key in enumerate(("book-1", "book-2")):
                jobs.start({**self.request, "jobId": key})
                self.assertEqual(self.wait(jobs, key)["state"], "done")
            jobs.shutdown()
            for created, key in enumerate(("book-1", "book-2")):
                state = json.loads((root / key / "state.json").read_text())
                (root / key / "state.json").write_text(json.dumps({**state, "state": "aligning",
                                                                    "createdAt": 1000.0 + created}))
                (root / key / "result.json").unlink()
                for group in (root / key / "groups").glob("[0-9]*.json"):
                    group.unlink()
            retained = book_session_folder_bytes(root / "book-1")
            need = retained + meta_bytes(len(self.request["sentences"]))
            budget = need + retained // 2
            stages = WorkerStages(self.media / "alignment", lambda: FakeModel(), "cpu", env=self.env)
            restarted = BookJobs(root, stages, SessionRegistry(DiskBudget(budget), idle=900))
            self.assertEqual(restarted.resume_all(), ["book-1", "book-2"])
            first, second = self.wait(restarted, "book-1"), self.wait(restarted, "book-2")
        self.assertEqual((first["state"], second["state"]), ("failed", "done"), (first, second))
        self.assertIn("never fit", first["error"])
        self.assertEqual(sorted(p.name for p in (root / "book-1").iterdir()), ["state.json"])
        restarted.shutdown()

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
            # Read before the fetch, which deletes the job's folder.
            fresh_group = json.loads((self.media / "alignment" / "book-jobs" / "book-2" / "groups" / "0.json")
                                     .read_text())["stats"]["emissionsDigest"]
            fresh = fresh_jobs.result("book-2")
        self.assertNotEqual(old_group, fresh_group, "the new audio gives other emissions")
        self.assertEqual(resumed["stats"]["emissionsDigest"], fresh["stats"]["emissionsDigest"],
                         "every group of the resumed job was aligned on the new audio's emissions")
        self.assertEqual(resumed["stats"]["groups"], 3)

    def test_encode_batches_share_the_window_gate_and_windows_come_first(self):
        import deadline
        gate = deadline.Gate(1)
        model = FakeModel()
        inner = model.model
        seen = []

        def batch(wave):  # the fake encoder: what the gate showed while a batch was on the device
            seen.append((gate.active, gate.busy, getattr(gate, "background_active", 0), time.monotonic()))
            time.sleep(0.1)
            return inner(wave)

        model.model = batch
        jobs = self.jobs(model)
        jobs.stages.admission = gate
        windows, refusals, stop = [], [], threading.Event()

        def window_client():  # the server's window requests: retry a 409 after a pause
            while not stop.is_set():
                try:
                    with gate.hold():
                        windows.append((time.monotonic(), model.calls))
                        time.sleep(0.01)
                except deadline.WorkerBusy:
                    refusals.append(time.monotonic())
                    time.sleep(0.1)
                    continue
                time.sleep(0.15)

        client = threading.Thread(target=window_client)
        with mock.patch.multiple(deadline, create=True, WINDOW_GRACE_S=0.05, WINDOW_RETRY_S=1.0), \
                mock.patch.dict(os.environ, {"ALIGNMENT_BOOK_ENCODE_BATCH": "1"}), \
                mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                  self.plan(longform.em.shape[0])):
            client.start()
            jobs.start(self.request)
            status = self.wait(jobs)
            stop.set()
            client.join(10)
        self.assertEqual(status["state"], "done", status)
        self.assertGreater(len(seen), 3)
        self.assertEqual({(a, b, c) for a, b, c, _ in seen}, {(0, False, 1)},
                         "each batch held the gate's one slot; /health's window fields do not show it")
        self.assertEqual(refusals, [], "a book batch never makes a window request refused")
        during = [calls for _, calls in windows if 0 < calls < len(seen)]
        self.assertTrue(during, "window requests ran between the book's batches")
        self.assertEqual(gate.active, 0)

    def test_the_model_is_loaded_while_holding_the_gate_like_a_batch(self):
        # Review round 5: the load holds the model lock the window endpoints need, so it must not run
        # beside a window request that could then wait on that lock without the gate's bound.
        import deadline
        gate = deadline.Gate(1)
        model = FakeModel()
        jobs = self.jobs(model)
        jobs.stages.admission = gate
        seen = []

        def loader():
            seen.append((gate.background_active, gate.active))
            return model

        jobs.stages.model_loader = loader
        with mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                               self.plan(longform.em.shape[0])):
            jobs.start(self.request)
            status = self.wait(jobs)
        self.assertEqual(status["state"], "done", status)
        self.assertEqual(seen, [(1, 0)], "the load held the gate's background slot")
        self.assertEqual(gate.background_active, 0)

    def test_a_book_waiting_for_window_requests_reports_it_and_the_queue_stays_truthful(self):
        import deadline
        gate = deadline.Gate(1)
        jobs = self.jobs(FakeModel())
        jobs.stages.admission = gate
        with mock.patch.multiple(deadline, create=True, WINDOW_GRACE_S=0.0, WINDOW_RETRY_S=0.0), \
                mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                  self.plan(longform.em.shape[0])):
            with gate.hold():  # a window request that lasts while both books are ready to encode
                jobs.start(self.request)
                jobs.start({**self.request, "jobId": "book-2"})
                deadline_at = time.monotonic() + 60

                def holder_and_next():  # whichever book decoded first holds the encoder
                    states = [jobs.status(key) for key in ("book-1", "book-2")]
                    states.sort(key=lambda state: state["progress"].get("encodeQueuePosition") is None or
                                state["progress"].get("encodeQueuePosition"))
                    return states

                while True:
                    first, second = holder_and_next()
                    if first["progress"].get("waitingForWindowRequests") and \
                            second["progress"].get("encodeQueuePosition") == 1:
                        break
                    self.assertLess(time.monotonic(), deadline_at, (first, second))
                    time.sleep(0.05)
                time.sleep(0.3)
                first, second = holder_and_next()
                self.assertEqual(first["state"], "encoding")
                self.assertEqual(first["progress"]["encodeQueuePosition"], 0, "it holds the encoder")
                self.assertGreaterEqual(first["progress"]["gateWaitSeconds"], 0.3, "and says how long it has waited")
                self.assertEqual(second["progress"]["encodeQueuePosition"], 1, "the next book waits behind it")
                self.assertNotIn("waitingForWindowRequests", second["progress"])
                self.assertEqual(gate.background_active, 0)
                holder = first["jobId"]
            for key in ("book-1", "book-2"):
                self.assertEqual(self.wait(jobs, key)["state"], "done")
        status = jobs.status(holder)
        self.assertGreaterEqual(status["stageTimings"]["gateWait"], 0.3)
        self.assertIs(status["progress"]["waitingForWindowRequests"], False)

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


def book_session_folder_bytes(folder):
    total = 0
    for directory, _dirs, files in os.walk(folder):
        for name in files:
            try:
                total += os.stat(os.path.join(directory, name)).st_size
            except OSError:
                pass
    return total


def running(pid):
    """True while the process exists and has not exited (a zombie has exited)."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


@unittest.skipUnless(READY and sys.platform.startswith("linux"), "Linux, numpy, torch and ffmpeg are needed")
class StopGroups(PipelineFixture):
    """Cancel, idle end and worker stop end running group processes before the folder and the budget go."""

    def setUp(self):
        super().setUp()
        self.env = {"ALIGNMENT_BOOK_ALIGN_WORKERS": "2"}
        self.pids = self.dir / "pids"
        self.pids.mkdir()

    def tearDown(self):
        for pid in self.started_pids():
            try:
                os.kill(pid, 9)  # never leave a sleeper behind, even when the test fails
            except OSError:
                pass
        super().tearDown()

    def started_pids(self):
        return [int(p.name) for p in self.pids.iterdir()] if self.pids.exists() else []

    def run_until_groups_run(self):
        import book_pool_helpers
        import book_session
        jobs = self.jobs(FakeModel())
        patches = [mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                     self.plan(longform.em.shape[0])),
                   mock.patch.object(book_align, "pool_align", book_pool_helpers.sleep_ignoring_term),
                   mock.patch.object(book_session, "TERMINATE_GRACE_S", 0.5, create=True),
                   mock.patch.dict(os.environ, {"BOOK_TEST_PID_DIR": str(self.pids)})]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        jobs.start(self.request)
        deadline = time.monotonic() + 120
        while len(self.started_pids()) < 2:
            self.assertLess(time.monotonic(), deadline, jobs.status("book-1"))
            time.sleep(0.1)
        pids = self.started_pids()
        self.assertTrue(all(running(pid) for pid in pids))
        return jobs, pids

    def assert_stopped(self, pids, started, folder_kept):
        folder = self.media / "alignment" / "book-jobs" / "book-1"
        self.assertEqual([pid for pid in pids if running(pid)], [], "a group process outlived the job")
        self.assertLess(time.monotonic() - started, 20, "the stop waited for the processes, not for their groups")
        self.assertEqual(folder.exists(), folder_kept)

    def test_cancel_stops_running_group_processes(self):
        jobs, pids = self.run_until_groups_run()
        started = time.monotonic()
        self.assertEqual(jobs.cancel("book-1")["state"], "cancelled")
        self.assert_stopped(pids, started, folder_kept=False)
        self.assertEqual(jobs.registry.budget.reserved(), 0)

    def test_idle_end_stops_running_group_processes(self):
        jobs, pids = self.run_until_groups_run()
        jobs._job("book-1").last_request -= 10_000
        started = time.monotonic()
        self.assertEqual(jobs.sweep(), ["book-1"])
        self.assert_stopped(pids, started, folder_kept=False)
        self.assertEqual(jobs.registry.budget.reserved(), 0)

    def leftover_through(self, there):
        """A job whose leftover pass hands three pieces to the pool, where `there` runs them."""
        import book_pool_helpers
        import book_session
        seen = {}

        def leftover_pass(longform, chain, should_stop=None, run_pieces=None):
            seen["outputs"] = run_pieces([{"index": n} for n in range(3)])
            return [], {"pieces": 0}

        patches = [mock.patch.object(book_align, "plan_groups", lambda longform, should_stop=None:
                                     self.plan(longform.em.shape[0])),
                   mock.patch.object(book_align, "leftover_pass", leftover_pass),
                   mock.patch.object(book_align, "pool_piece", getattr(book_pool_helpers, there)),
                   mock.patch.object(book_session, "TERMINATE_GRACE_S", 0.5, create=True),
                   mock.patch.dict(os.environ, {"BOOK_TEST_PID_DIR": str(self.pids)})]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        jobs = self.jobs(FakeModel())
        jobs.start(self.request)
        return jobs, seen

    def test_leftover_pieces_run_in_the_pool_and_come_back_in_order(self):
        jobs, seen = self.leftover_through("echo_piece")
        self.assertEqual(self.wait(jobs)["state"], "done")
        self.assertEqual(seen["outputs"], [{0: (0, 5)}, {1: (10, 15)}, {2: (20, 25)}])
        self.assertIsNone(jobs.registry.get("book-1").pool)  # released once its processes exited

    def test_cancel_stops_running_leftover_processes(self):
        jobs, _ = self.leftover_through("sleep_ignoring_term")
        deadline = time.monotonic() + 120
        while len(self.started_pids()) < 2:
            self.assertLess(time.monotonic(), deadline, jobs.status("book-1"))
            time.sleep(0.1)
        pids = self.started_pids()
        started = time.monotonic()
        self.assertEqual(jobs.cancel("book-1")["state"], "cancelled")
        self.assert_stopped(pids, started, folder_kept=False)
        self.assertEqual(jobs.registry.budget.reserved(), 0)

    def test_worker_stop_stops_running_group_processes(self):
        jobs, pids = self.run_until_groups_run()
        started = time.monotonic()
        jobs.shutdown()
        self.assert_stopped(pids, started, folder_kept=True)
        self.assertEqual(jobs.registry.budget.reserved(), 0)


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
                conflict = client.post("/book-jobs", json={**body, "recordingId": "r2"}, headers=auth)
                self.assertEqual(conflict.status_code, 409)
                result = client.get("/book-jobs/http-1/result", headers=auth)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json()["engine"], align.BOOK_ENGINE)
                # Fetched: the job's folder is gone with its reservation, so the job is unknown now.
                self.assertEqual(client.get("/book-jobs/http-1", headers=auth).status_code, 404)
                self.assertEqual(client.get("/book-jobs/http-1/result", headers=auth).status_code, 404)
                self.assertFalse((media / "alignment" / "book-jobs" / "http-1").exists())
                again = client.post("/book-jobs", json=body, headers=auth)
                self.assertEqual(again.status_code, 202, again.text)
                self.assertEqual(client.delete("/book-jobs/http-1", headers=auth).json()["state"], "cancelled")
                self.assertEqual(client.get("/book-jobs/http-1", headers=auth).status_code, 404)
                self.assertEqual(client.get("/book-jobs/missing/result", headers=auth).status_code, 404)
                self.assertEqual(client.get("/health").json()["bookJobs"]["engine"], align.BOOK_ENGINE)
                align.book_jobs.shutdown()
                sys.modules.pop("align", None)


if __name__ == "__main__":
    unittest.main()
