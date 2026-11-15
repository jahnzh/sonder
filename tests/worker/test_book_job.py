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
from unittest import mock
import book_job
import deadline
from book_job import BOOK_ENGINE, BookJobs, JobConflict, NotReady, UnknownJob, request_digest
from book_session import BudgetExceeded, DiskBudget, SessionRegistry
import ctc_acoustic

# The tests' budgets are a few KB: a new job reserves its request plus this for its state file.
STATE = 1024


class FakeStages:
    """Groups 0..groups-1, each written to groups/<n>.json; `gate` can hold a group until released."""

    def __init__(self, groups=4, fail_at=None, reserve=1000, before_reserve=None, fail_with=None, gate=None,
                 ignore_stop=None, raise_after_ignore=None):
        self.groups = groups
        self.fail_at = fail_at
        self.reserve = reserve
        self.before_reserve = before_reserve  # an Event the job waits for before it reserves
        self.fail_with = fail_with  # the message of the failure at fail_at
        self.gate = gate  # a deadline.Gate the "encode" takes once before the groups, as the real encode does
        self.ignore_stop = ignore_stop  # an Event the job waits for without looking at should_stop
        self.raise_after_ignore = raise_after_ignore  # raised once ignore_stop is set
        self.order = []  # keys in the order their stages started
        self.aligned = []
        self.gates = {}
        self.started = threading.Event()
        self.entered = threading.Event()
        self.reached = {}

    def encode_position(self, key):
        return None

    def hold(self, group):
        self.gates[group] = threading.Event()
        self.reached[group] = threading.Event()

    def run(self, job, session, should_stop):
        self.order.append(job.key)
        self.entered.set()
        if self.ignore_stop is not None:
            self.ignore_stop.wait(30)
            if self.raise_after_ignore is not None:
                raise self.raise_after_ignore
        if self.before_reserve is not None:
            while not self.before_reserve.wait(0.01):
                if should_stop():
                    return
        session.reserve_disk(self.reserve, should_wait=lambda: not should_stop(), poll=0.01)
        self.started.set()
        if self.gate is not None:
            with self.gate.hold_background(should_stop, poll=0.01, on_wait=job.gate_wait):
                pass
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
                raise RuntimeError(self.fail_with or "group failed")
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
        return BookJobs(self.root, stages, registry, clock=self.clock, state_bytes=STATE)

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
        # Fetching ends the job: its whole folder goes and its reservation is released with it.
        self.assertIsNone(jobs.registry.get("job-1"))
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertFalse((self.root / "job-1").exists())
        with self.assertRaises(UnknownJob):
            jobs.result("job-1")

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

    def test_a_failed_job_keeps_only_a_small_counted_error_record_until_the_idle_sweep(self):
        jobs = self.jobs(FakeStages(fail_at=2, fail_with="x" * 5000))
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        folder = self.root / "job-1"
        self.assertEqual(sorted(p.name for p in folder.rglob("*")), ["state.json"],
                         "request, emissions and groups are deleted; only the error record stays")
        record = (folder / "state.json").stat().st_size
        self.assertLess(record, 4096)
        self.assertEqual(jobs.registry.budget.reserved("job-1"), record, "the record is counted")
        status = jobs.status("job-1")
        self.assertEqual((status["state"], len(status["error"])), ("failed", book_job.ERROR_CHARS))
        self.assertEqual(jobs.start(request())["state"], "failed", "the same request reads the record")
        self.clock.now += 900
        self.assertEqual(jobs.sweep(), ["job-1"])
        self.assertFalse(folder.exists())
        self.assertEqual(jobs.registry.budget.reserved(), 0)

    def test_a_failed_jobs_record_survives_a_restart_and_is_swept(self):
        jobs = self.jobs(FakeStages(fail_at=0))
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        jobs.shutdown()
        restarted = self.jobs(FakeStages())
        self.assertEqual(restarted.resume_all(), [])
        self.assertEqual(restarted.status("job-1")["state"], "failed")
        self.assertEqual(restarted.registry.budget.reserved("job-1"), (self.root / "job-1" / "state.json").stat().st_size)
        self.clock.now += 900
        self.assertEqual(restarted.sweep(), ["job-1"])
        self.assertFalse((self.root / "job-1").exists())
        self.assertEqual(restarted.registry.budget.reserved(), 0)

    def test_a_request_that_does_not_fit_is_refused_before_anything_is_written(self):
        stages = FakeStages(reserve=9000)
        stages.hold(1)
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(stages.reached[1].wait(5))
        with self.assertRaises(BudgetExceeded) as refused:
            jobs.start(request("job-2"))
        self.assertIn("full", str(refused.exception))
        self.assertFalse((self.root / "job-2").exists(), "nothing of the refused request is written")
        self.assertEqual(jobs.registry.budget.reserved("job-2"), 0)
        self.assertIsNone(jobs.registry.get("job-2"))
        with self.assertRaises(UnknownJob):
            jobs.status("job-2")
        stages.gates[1].set()
        self.assertTrue(self.done(jobs))

    def test_a_new_jobs_request_and_state_are_counted_from_the_start(self):
        hold = threading.Event()
        jobs = self.jobs(FakeStages(before_reserve=hold))
        body = request(text="word " * 500)
        jobs.start(body)
        written = sum(f.stat().st_size for f in (self.root / "job-1").rglob("*") if f.is_file())
        self.assertGreaterEqual(jobs.registry.budget.reserved("job-1"), written)
        self.assertGreaterEqual(jobs.registry.budget.reserved("job-1"), len(json.dumps(body)) - 100)
        hold.set()
        self.assertTrue(self.done(jobs))

    def test_a_book_over_the_budget_fails(self):
        jobs = self.jobs(FakeStages(reserve=3000), budget=2500)
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

    def stopped_with_retained_files(self, nbytes):
        """job-1 stopped by the worker in group 2, with `nbytes` of emissions left in its folder."""
        first = FakeStages()
        first.hold(2)
        jobs = self.jobs(first)
        jobs.start(request())
        self.assertTrue(first.reached[2].wait(5))
        jobs.shutdown()
        (self.root / "job-1" / "emissions" / "1.f16").write_bytes(b"\0" * nbytes)
        return sum(f.stat().st_size for f in (self.root / "job-1").rglob("*") if f.is_file())

    def test_a_restart_claims_the_retained_files_before_any_job_runs(self):
        on_disk = self.stopped_with_retained_files(6000)
        hold = threading.Event()  # the resumed job has not reached its own reservation yet
        restarted = self.jobs(FakeStages(before_reserve=hold))
        self.assertEqual(restarted.resume_all(), ["job-1"])
        self.assertEqual(restarted.registry.budget.reserved("job-1"), on_disk)
        hold.set()
        self.assertTrue(self.done(restarted))

    def test_a_new_job_waits_while_retained_files_fill_the_budget(self):
        self.stopped_with_retained_files(6000)
        hold = threading.Event()
        resumed = FakeStages(before_reserve=hold)
        restarted = self.jobs(resumed)
        restarted.resume_all()
        self.assertTrue(resumed.entered.wait(5))
        newcomer = FakeStages(reserve=5000)
        restarted.stages = newcomer  # the second job's stages
        restarted.start(request("job-2"))
        self.assertFalse(newcomer.started.wait(0.3), "6,000 retained bytes and 5,000 more exceed 10,000")
        restarted.cancel("job-1")  # its files go, and with them its claim
        self.assertTrue(newcomer.started.wait(5))
        self.assertTrue(self.done(restarted, "job-2"))
        hold.set()

    def retained(self, keys, nbytes, created):
        """Unfinished jobs `keys`, stopped by the worker in group 2, each with `nbytes` of retained emissions
        and the creation times `created` (key -> seconds)."""
        for key in keys:
            first = FakeStages()
            first.hold(2)
            jobs = self.jobs(first, budget=10 ** 6)
            jobs.start(request(key))
            self.assertTrue(first.reached[2].wait(5))
            jobs.shutdown()
            folder = self.root / key
            (folder / "emissions" / "1.f16").write_bytes(b"\0" * nbytes)
            state = json.loads((folder / "state.json").read_text())
            (folder / "state.json").write_text(json.dumps({**state, "createdAt": created[key]}))

    def test_two_retained_jobs_that_need_each_others_disk_do_not_wait_forever(self):
        # Each keeps 4,000 B of emissions and needs 7,000 B for its next stage in a 10,000 B budget: neither
        # can run next to the other's files. The older resumes first, cannot fit while the other's files wait
        # for it, and fails with a clear error and its files released; then the other runs.
        self.retained(["job-a", "job-b"], 4000, {"job-a": 100.0, "job-b": 200.0})
        stages = FakeStages(reserve=7000)
        restarted = self.jobs(stages)
        self.assertEqual(restarted.resume_all(), ["job-a", "job-b"])
        self.assertTrue(self.done(restarted, "job-a"), restarted.status("job-a"))
        self.assertTrue(self.done(restarted, "job-b"), restarted.status("job-b"))
        a, b = restarted.status("job-a"), restarted.status("job-b")
        self.assertEqual((a["state"], b["state"]), ("failed", "done"), (a, b))
        self.assertIn("never fit", a["error"])
        self.assertEqual(stages.order, ["job-a", "job-b"])

    def test_retained_jobs_resume_one_at_a_time_oldest_first(self):
        self.retained(["job-a", "job-b", "job-c"], 100, {"job-a": 300.0, "job-b": 100.0, "job-c": 200.0})
        stages = FakeStages()
        stages.hold(3)
        restarted = self.jobs(stages, budget=10 ** 6)
        self.assertEqual(restarted.resume_all(), ["job-b", "job-c", "job-a"])
        self.assertTrue(stages.reached[3].wait(5))
        self.assertEqual(stages.order, ["job-b"], "the next resumes only when this one has ended")
        self.assertEqual(restarted.status("job-c")["progress"]["resumeQueuePosition"], 1)
        self.assertEqual(restarted.status("job-a")["progress"]["resumeQueuePosition"], 2)
        self.assertEqual(restarted.status("job-c")["state"], "queued")
        restarted.start(request("job-a"))  # the server asking again does not jump the queue
        self.assertEqual(stages.order, ["job-b"])
        stages.gates[3].set()
        for key in ("job-b", "job-c", "job-a"):
            self.assertTrue(self.done(restarted, key))
            self.assertEqual(restarted.status(key)["state"], "done")
        self.assertEqual(stages.order, ["job-b", "job-c", "job-a"])

    def test_cancelling_a_job_that_waits_to_resume_releases_its_files(self):
        self.retained(["job-a", "job-b"], 100, {"job-a": 100.0, "job-b": 200.0})
        stages = FakeStages()
        stages.hold(3)
        restarted = self.jobs(stages, budget=10 ** 6)
        restarted.resume_all()
        self.assertTrue(stages.reached[3].wait(5))
        restarted.cancel("job-b")
        self.assertFalse((self.root / "job-b").exists())
        self.assertEqual(restarted.registry.budget.reserved("job-b"), 0)
        stages.gates[3].set()
        self.assertTrue(self.done(restarted, "job-a"))
        time.sleep(0.1)
        self.assertEqual(stages.order, ["job-a"], "a cancelled job is not resumed")

    def test_a_job_thread_that_does_not_stop_keeps_its_folder_and_reservation(self):
        never = threading.Event()
        stages = FakeStages(ignore_stop=never)  # stuck in a step that does not look at should_stop
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(stages.entered.wait(5))
        reserved = jobs.registry.budget.reserved("job-1")
        with mock.patch.object(book_job, "STOP_WAIT_S", 0.2, create=True):
            self.assertEqual(jobs.cancel("job-1")["state"], "cancelled")
        self.assertTrue((self.root / "job-1").exists(), "not deleted under a running thread")
        self.assertEqual(jobs.registry.budget.reserved("job-1"), reserved)
        self.assertEqual([s["jobId"] for s in jobs.registry.stuck()], ["job-1"])
        with self.assertRaises(JobConflict):
            jobs.start(request())  # the same id cannot start while the old one is still stopping
        self.assertEqual(jobs.sweep(), [])
        self.assertTrue((self.root / "job-1").exists())
        never.set()
        self.assertTrue(wait_for(lambda: not jobs.registry.stuck() or jobs.sweep() is None))
        jobs.sweep()
        self.assertFalse((self.root / "job-1").exists())
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertEqual(jobs.registry.stuck(), [])

    def test_two_ends_at_once_never_delete_the_folder_of_a_live_job_thread(self):
        # The review's reproduction: two ends of one job at once (cancel with cancel, cancel with the idle
        # sweep) while the job's thread does not stop. Neither may delete the folder or release the
        # reservation; both get the first end's outcome, and the job is reported stuck.
        for other in ("cancel", "idle"):
            with self.subTest(other=other):
                never = threading.Event()
                stages = FakeStages(ignore_stop=never)
                jobs = self.jobs(stages)
                key = f"job-{other}"
                jobs.start(request(key))
                self.assertTrue(stages.entered.wait(5))
                reserved = jobs.registry.budget.reserved(key)
                self.clock.now += 900  # idle, for the sweep
                outcomes = []
                calls = [lambda: outcomes.append(jobs.cancel(key)["state"]),
                         (lambda: outcomes.append(jobs.cancel(key)["state"])) if other == "cancel"
                         else (lambda: outcomes.append(jobs.sweep()))]
                with mock.patch.object(book_job, "STOP_WAIT_S", 0.3, create=True):
                    threads = [threading.Thread(target=call, daemon=True) for call in calls]
                    for thread in threads:
                        thread.start()
                    for thread in threads:
                        thread.join(10)
                self.assertEqual(len(outcomes), 2)
                self.assertTrue((self.root / key).exists(), "not deleted under a running thread")
                self.assertEqual(jobs.registry.budget.reserved(key), reserved)
                self.assertEqual([s["jobId"] for s in jobs.registry.stuck()], [key])
                never.set()
                stages_thread_done = wait_for(lambda: not any(
                    t.name == f"book-job-{key}" and t.is_alive() for t in threading.enumerate()))
                self.assertTrue(stages_thread_done)
                jobs.sweep()
                self.assertFalse((self.root / key).exists())
                self.assertEqual(jobs.registry.budget.reserved(), 0)
                self.assertEqual(jobs.registry.stuck(), [])

    def test_a_failure_after_an_end_writes_no_record_and_releases_nothing(self):
        # Cancel ends a job whose thread does not stop (stuck); the thread then fails. Its failure must not
        # end the job a second time (delete the stuck folder, release, write and claim an error record).
        never = threading.Event()
        stages = FakeStages(ignore_stop=never, raise_after_ignore=BudgetExceeded("too big"))
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(stages.entered.wait(5))
        (self.root / "job-1" / "emissions").mkdir()
        reserved = jobs.registry.budget.reserved("job-1")
        with mock.patch.object(book_job, "STOP_WAIT_S", 0.2, create=True):
            jobs.cancel("job-1")
        self.assertEqual([s["jobId"] for s in jobs.registry.stuck()], ["job-1"])
        never.set()
        self.assertTrue(wait_for(lambda: not any(t.name == "book-job-job-1" and t.is_alive()
                                                 for t in threading.enumerate())))
        self.assertTrue((self.root / "job-1" / "emissions").exists(), "the stuck end's folder is untouched")
        self.assertEqual(jobs.registry.budget.reserved("job-1"), reserved)
        jobs.sweep()
        self.assertFalse((self.root / "job-1").exists())
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        with self.assertRaises(UnknownJob):
            jobs.status("job-1")

    def test_a_job_waiting_for_window_requests_reports_it(self):
        gate = deadline.Gate(1)
        stages = FakeStages(gate=gate)
        jobs = self.jobs(stages)
        with mock.patch.multiple(deadline, WINDOW_GRACE_S=0.0, WINDOW_RETRY_S=0.0):
            with gate.hold():  # a window request runs: the book's batch waits for it
                jobs.start(request())
                self.assertTrue(wait_for(lambda: jobs.status("job-1")["progress"].get("waitingForWindowRequests")))
                time.sleep(0.25)
                progress = jobs.status("job-1")["progress"]
                self.assertGreaterEqual(progress["gateWaitSeconds"], 0.2)
                self.assertNotIn("gateWaitSince", progress)
            self.assertTrue(self.done(jobs))
        status = jobs.status("job-1")
        self.assertEqual(status["state"], "done")
        self.assertIs(status["progress"]["waitingForWindowRequests"], False)
        self.assertNotIn("gateWaitSeconds", status["progress"])
        self.assertGreaterEqual(status["stageTimings"]["gateWait"], 0.2)

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
