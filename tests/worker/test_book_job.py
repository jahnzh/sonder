"""Whole-book job lifecycle (#402): start, progress, cancel, result, idle end and resume after a restart.

The stages are fakes that keep the real jobs' on-disk convention (one file per finished group), so this
runs with the standard library only. The real stages are covered by test_book_pipeline.py.
"""
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from book_job import BOOK_ENGINE, BookJobs, JobConflict, NotReady, UnknownJob, request_digest
from book_session import DiskBudget, SessionRegistry
import ctc_acoustic


class FakeStages:
    """Groups 0..groups-1, each written to groups/<n>.json; `gate` can hold a group until released."""

    def __init__(self, groups=4, fail_at=None):
        self.groups = groups
        self.fail_at = fail_at
        self.aligned = []
        self.gates = {}
        self.started = threading.Event()
        self.reached = {}

    def encode_position(self, key):
        return None

    def hold(self, group):
        self.gates[group] = threading.Event()
        self.reached[group] = threading.Event()

    def run(self, job, session, should_stop):
        session.reserve_disk(1000)
        self.started.set()
        folder = job.folder / "groups"
        folder.mkdir(exist_ok=True)
        (job.folder / "emissions").mkdir(exist_ok=True)
        (job.folder / "emissions" / "0.f16").write_bytes(b"\0" * 58)
        job.update(state="aligning")
        job.progress(groupsTotal=self.groups)
        for group in range(self.groups):
            if (folder / f"{group}.json").is_file():
                continue
            if group in self.gates:
                self.reached[group].set()
                while not self.gates[group].wait(0.01):
                    if should_stop():
                        return
            if should_stop():
                return
            if group == self.fail_at:
                raise RuntimeError("group failed")
            self.aligned.append(group)
            (folder / f"{group}.json").write_text(json.dumps({"index": group}))
            job.progress(groupsDone=group + 1)
        (job.folder / "result.json").write_text(json.dumps(
            {"jobId": job.key, "engine": BOOK_ENGINE, "outcome": "mapped", "intervals": [
                {"paragraphId": "p0", "section": 0, "trackId": "t0", "start": 1.0, "end": 2.0, "confidence": 0.65}]}))


class Clock:
    def __init__(self):
        self.now = 5000.0

    def __call__(self):
        return self.now


def request(job_id="job-1", text="Hello there."):
    return {"jobId": job_id, "recordingId": "recording-1", "audioFingerprint": "fp", "language": "eng",
            "sentences": [{"id": "p0", "section": 0, "text": text}],
            "tracks": [{"id": "t0", "audio": "/media/t0.mp3", "duration": 60.0}]}


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class Jobs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "book-jobs"
        self.clock = Clock()

    def tearDown(self):
        self.tmp.cleanup()

    def jobs(self, stages, budget=10_000):
        registry = SessionRegistry(DiskBudget(budget), idle=900, clock=self.clock)
        return BookJobs(self.root, stages, registry, clock=self.clock)

    def done(self, jobs, key="job-1"):
        return wait_for(lambda: jobs.status(key)["state"] in ("done", "failed", "cancelled"))

    def test_start_progress_and_result(self):
        stages = FakeStages()
        jobs = self.jobs(stages)
        status = jobs.start(request())
        self.assertEqual(status["engine"], BOOK_ENGINE)
        self.assertNotEqual(status["engine"], ctc_acoustic.ENGINE, "the book aligner is a new engine generation")
        self.assertTrue(self.done(jobs))
        status = jobs.status("job-1")
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["progress"]["groupsDone"], 4)
        self.assertEqual(status["progress"]["groupsTotal"], 4)
        self.assertNotIn("digest", status)
        result = jobs.result("job-1")
        self.assertEqual(result["outcome"], "mapped")
        self.assertEqual(set(result["intervals"][0]), {"paragraphId", "section", "trackId", "start", "end", "confidence"})
        # Fetching ends the session: emissions are gone, the budget is free, the result can be fetched again.
        self.assertIsNone(jobs.registry.get("job-1"))
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertFalse((self.root / "job-1" / "emissions").exists())
        self.assertEqual(jobs.result("job-1")["outcome"], "mapped")
        self.assertTrue(jobs.status("job-1")["fetched"])

    def test_result_before_the_end_is_not_ready(self):
        stages = FakeStages()
        stages.hold(1)
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(stages.reached[1].wait(5))
        with self.assertRaises(NotReady):
            jobs.result("job-1")
        self.assertEqual(jobs.status("job-1")["progress"]["groupsDone"], 1)
        stages.gates[1].set()
        self.assertTrue(self.done(jobs))

    def test_same_request_is_idempotent_and_another_conflicts(self):
        stages = FakeStages()
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        self.assertEqual(jobs.start(request())["state"], "done")
        self.assertEqual(stages.aligned, [0, 1, 2, 3], "a repeated start does not run the job again")
        with self.assertRaises(JobConflict):
            jobs.start(request(text="Another text."))

    def test_cancel_stops_the_job_and_releases_its_session(self):
        stages = FakeStages()
        stages.hold(2)
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(stages.reached[2].wait(5))
        session = jobs.registry.get("job-1")
        self.assertEqual(jobs.registry.budget.reserved(), 1000)
        self.assertEqual(jobs.cancel("job-1")["state"], "cancelled")
        self.assertEqual(session.ended, "cancelled")
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertFalse((self.root / "job-1").exists())
        self.assertEqual(stages.aligned, [0, 1])
        with self.assertRaises(UnknownJob):
            jobs.status("job-1")

    def test_failure_is_reported_and_releases_the_session(self):
        jobs = self.jobs(FakeStages(fail_at=1))
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        status = jobs.status("job-1")
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["error"], "group failed")
        self.assertIsNone(jobs.registry.get("job-1"))
        self.assertEqual(jobs.registry.budget.reserved(), 0)

    def test_a_book_over_the_budget_fails(self):
        jobs = self.jobs(FakeStages(), budget=500)
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        self.assertEqual(jobs.status("job-1")["state"], "failed")
        self.assertIn("budget", jobs.status("job-1")["error"])

    def test_idle_end_after_fifteen_minutes_without_a_request(self):
        stages = FakeStages()
        stages.hold(1)
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(stages.reached[1].wait(5))
        session = jobs.registry.get("job-1")
        self.clock.now += 600
        jobs.status("job-1")  # the server is still polling
        self.clock.now += 899
        self.assertEqual(jobs.sweep(), [])
        self.clock.now += 1
        self.assertEqual(jobs.sweep(), ["job-1"])
        self.assertEqual(session.ended, "idle")
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertFalse((self.root / "job-1").exists())
        self.assertEqual(stages.aligned, [0])

    def test_a_finished_unfetched_job_ends_when_idle(self):
        jobs = self.jobs(FakeStages())
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        self.clock.now += 900
        self.assertEqual(jobs.sweep(), ["job-1"])
        self.assertIsNone(jobs.registry.get("job-1"))
        self.assertFalse((self.root / "job-1").exists())

    def test_resume_after_a_restart_keeps_finished_groups(self):
        first = FakeStages()
        first.hold(2)
        jobs = self.jobs(first)
        jobs.start(request())
        self.assertTrue(first.reached[2].wait(5))
        jobs.shutdown()  # worker stop in the middle of group 2
        self.assertEqual(first.aligned, [0, 1])
        self.assertTrue((self.root / "job-1" / "groups" / "1.json").is_file())
        self.assertTrue((self.root / "job-1" / "emissions" / "0.f16").is_file(), "emissions survive the stop")
        self.assertEqual(json.loads((self.root / "job-1" / "state.json").read_text())["state"], "aligning")

        second = FakeStages()
        restarted = self.jobs(second)
        self.assertEqual(restarted.resume_all(), ["job-1"])
        self.assertTrue(self.done(restarted))
        self.assertEqual(second.aligned, [2, 3], "finished groups are not aligned again")
        status = restarted.status("job-1")
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["resumed"], 1)
        self.assertEqual(restarted.result("job-1")["outcome"], "mapped")

    def test_restart_keeps_a_finished_result_and_skips_foreign_folders(self):
        jobs = self.jobs(FakeStages())
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        jobs.shutdown()
        (self.root / "not-a-job").mkdir()
        (self.root / "bad id!").mkdir()
        stages = FakeStages()
        restarted = self.jobs(stages)
        self.assertEqual(restarted.resume_all(), [])
        self.assertEqual(restarted.keys(), ["job-1"])
        self.assertEqual(stages.aligned, [])
        self.assertEqual(restarted.result("job-1")["outcome"], "mapped")

    def test_restart_with_a_changed_request_starts_over(self):
        jobs = self.jobs(FakeStages())
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        jobs.shutdown()
        stages = FakeStages()
        restarted = self.jobs(stages)
        with self.assertRaises(JobConflict):
            restarted.start(request(text="Changed."))

    def test_language_not_supported(self):
        stages = FakeStages()
        jobs = self.jobs(stages)
        jobs.start({**request(), "language": "spa"})
        self.assertTrue(self.done(jobs))
        self.assertEqual(jobs.result("job-1")["outcome"], "language_not_supported")
        self.assertEqual(stages.aligned, [])

    def test_unknown_and_invalid_ids(self):
        jobs = self.jobs(FakeStages())
        with self.assertRaises(UnknownJob):
            jobs.status("missing")
        with self.assertRaises(UnknownJob):
            jobs.cancel("missing")
        with self.assertRaises(ValueError):
            jobs.start(request(job_id="../escape"))

    def test_digest_covers_the_text_tracks_and_identity(self):
        base = request_digest(request())
        self.assertNotEqual(base, request_digest(request(text="Other.")))
        self.assertNotEqual(base, request_digest({**request(), "recordingId": "other"}))
        self.assertEqual(base, request_digest({**request(), "jobId": "renamed"}))


if __name__ == "__main__":
    unittest.main()
