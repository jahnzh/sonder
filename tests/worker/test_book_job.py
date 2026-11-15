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
import book_report
import book_session
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


def rmtree_that_cannot_delete(*kept):
    """shutil.rmtree for book_session/book_job where the files named `kept` fail to delete (an I/O or
    permission error, ignored as with ignore_errors=True)."""
    real = book_session.shutil.rmtree

    def rmtree(path, ignore_errors=False, **kwargs):
        path = Path(path)
        for file in sorted(path.rglob("*"), reverse=True):
            if file.name in kept:
                continue
            if file.is_dir():
                if not any(file.iterdir()):
                    file.rmdir()
            else:
                file.unlink()
        if path.is_dir() and not any(path.iterdir()):
            real(path, ignore_errors=ignore_errors)

    return rmtree


class GreedyBudget(DiskBudget):
    """A budget with another book ("other") that takes every byte the moment `watch` lowers its reservation."""

    def __init__(self, total, watch):
        super().__init__(total)
        self.watch = watch
        self.peak = 0

    def _grab(self):
        free = self.total - self.reserved()
        if free > 0:
            DiskBudget.claim(self, "other", self.reserved("other") + free)

    def _note(self):
        self.peak = max(self.peak, self.reserved())

    def release(self, key):
        released = super().release(key)
        if key == self.watch:
            self._grab()
        self._note()
        return released

    def claim(self, key, nbytes):
        before = self.reserved(key)
        super().claim(key, nbytes)
        if key == self.watch and nbytes < before:
            self._grab()
        self._note()


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
        self.made = []

    def tearDown(self):
        # Stop every job thread before the folder goes: a thread still running records its failure and
        # recreates book-jobs/<job> inside the removed temporary directory, which is then left behind.
        for jobs in self.made:
            jobs.shutdown()
        self.tmp.cleanup()

    def track(self, jobs):
        self.made.append(jobs)
        return jobs

    def jobs(self, stages, budget=10_000):
        registry = SessionRegistry(DiskBudget(budget), idle=900, clock=self.clock)
        return self.track(BookJobs(self.root, stages, registry, clock=self.clock, state_bytes=STATE))

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

    def test_files_that_could_not_be_deleted_stay_reserved_and_the_job_is_reported_stuck(self):
        jobs = self.jobs(FakeStages())
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        left = (self.root / "job-1" / "emissions" / "0.f16").stat().st_size
        with mock.patch.object(book_session.shutil, "rmtree", rmtree_that_cannot_delete("0.f16")):
            jobs.result("job-1")  # the fetch ends the job; one emissions file fails to delete
        self.assertTrue((self.root / "job-1" / "emissions" / "0.f16").exists())
        self.assertEqual(jobs.registry.budget.reserved("job-1"), left, "only the removed bytes are released")
        self.assertEqual([(s["jobId"], s["reservedBytes"]) for s in jobs.registry.stuck()], [("job-1", left)])
        self.assertEqual(jobs.sweep(), [])  # deleting works again: the stuck session is released
        self.assertFalse((self.root / "job-1").exists())
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertEqual(jobs.registry.stuck(), [])

    def test_a_failed_job_reserves_its_error_record_before_it_releases_the_rest(self):
        # Another book takes every byte the failing job frees, at once: the record must already be reserved.
        budget = GreedyBudget(10_000, watch="job-1")
        registry = SessionRegistry(budget, idle=900, clock=self.clock)
        jobs = self.track(BookJobs(self.root, FakeStages(fail_at=1), registry, clock=self.clock, state_bytes=STATE))
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        self.assertEqual(jobs.status("job-1")["state"], "failed")
        jobs._jobs["job-1"].thread.join(5)  # "failed" is set in memory just before the record is written
        record = (self.root / "job-1" / "state.json").stat().st_size
        self.assertEqual(budget.reserved("job-1"), record)
        self.assertLessEqual(budget.peak, budget.total, "the record never takes the budget over its total")

    def test_a_failed_start_deletes_what_it_wrote(self):
        def broken_save(job):
            raise OSError(28, "No space left on device")

        jobs = self.jobs(FakeStages())
        with mock.patch.object(book_job.Job, "save", broken_save):
            with self.assertRaises(OSError):
                jobs.start(request())
        self.assertFalse((self.root / "job-1").exists(), "the request file it wrote is deleted")
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertIsNone(jobs.registry.get("job-1"))
        # The same, when the request file cannot be deleted: its bytes stay reserved, and are released once
        # it is gone.
        with mock.patch.object(book_job.Job, "save", broken_save), \
                mock.patch.object(book_session.shutil, "rmtree", rmtree_that_cannot_delete("request.json")):
            with self.assertRaises(OSError):
                jobs.start(request())
        kept = self.root / "job-1" / "request.json"
        self.assertTrue(kept.exists())
        self.assertEqual(jobs.registry.budget.reserved("job-1"), kept.stat().st_size)
        self.assertEqual([s["jobId"] for s in jobs.registry.stuck()], ["job-1"])
        jobs.sweep()
        self.assertFalse((self.root / "job-1").exists())
        self.assertEqual(jobs.registry.budget.reserved(), 0)
        self.assertEqual(jobs.start(request())["jobId"], "job-1", "the job can be started again")
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

    def blocked_folder_bytes(self, name):
        """book_job.folder_bytes that stalls on the folder `name` until `release` is set (a slow disk)."""
        real = book_job.folder_bytes
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def slow(folder):
            if Path(folder).name == name and not release.is_set():
                entered.set()
                release.wait(10)
            return real(folder)
        return mock.patch.object(book_job, "folder_bytes", slow), entered, release

    def answers_at_once(self, call, seconds=1.0):
        out, errors = [], []

        def run():
            try:
                out.append(call())
            except BaseException as error:  # noqa: BLE001 - raised again in the test's thread
                errors.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        thread.join(seconds)
        self.assertFalse(thread.is_alive(), f"{call} waited")
        if errors:
            raise errors[0]
        return out[0]

    def test_the_health_view_and_status_never_wait_for_a_start_on_a_slow_disk(self):
        # Round-4 review: /health (keys) and status took the jobs' lock, which a start holds across its
        # folder reads and writes.
        jobs = self.jobs(FakeStages())
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        patch, entered, release = self.blocked_folder_bytes("job-2")
        with patch:
            starter = threading.Thread(target=jobs.start, args=(request("job-2"),), daemon=True)
            starter.start()
            self.assertTrue(entered.wait(5), "the start is on its folder read, under the jobs' lock")
            self.assertEqual(self.answers_at_once(jobs.keys), ["job-1"])
            self.assertEqual(self.answers_at_once(lambda: jobs.status("job-1"))["state"], "done")
            self.assertEqual(self.answers_at_once(jobs.registry.stuck), [])
            self.answers_at_once(jobs.registry.budget.reserved)
            release.set()
            starter.join(5)
        self.assertEqual(sorted(jobs.keys()), ["job-1", "job-2"])
        self.assertTrue(self.done(jobs, "job-2"))

    def test_book_requests_get_resuming_until_the_background_resume_has_finished(self):
        jobs = self.jobs(FakeStages())
        jobs.start(request())
        self.assertTrue(self.done(jobs))
        files = {p.name: p.read_bytes() for p in (self.root / "job-1").iterdir() if p.is_file()}
        restarted = self.jobs(FakeStages())
        patch, entered, release = self.blocked_folder_bytes("job-1")
        with patch:
            thread = self.answers_at_once(restarted.resume_in_background)  # returns before the folder is read
            self.assertTrue(entered.wait(5))
            self.assertTrue(restarted.resuming)
            self.assertEqual(self.answers_at_once(restarted.keys), [])
            for call in (lambda: restarted.start(request()), lambda: restarted.status("job-1"),
                         lambda: restarted.cancel("job-1"), lambda: restarted.result("job-1")):
                with self.assertRaises(book_job.Resuming):
                    self.answers_at_once(call)
            self.assertEqual({p.name: p.read_bytes() for p in (self.root / "job-1").iterdir() if p.is_file()
                              if p.name != "state.json"},
                             {k: v for k, v in files.items() if k != "state.json"}, "the retained job is untouched")
            release.set()
            thread.join(5)
        self.assertFalse(restarted.resuming)
        self.assertEqual(restarted.status("job-1")["state"], "done")
        self.assertEqual(restarted.result("job-1")["outcome"], "mapped")

    def test_a_failed_background_resume_still_serves_book_requests(self):
        restarted = self.jobs(FakeStages())
        with mock.patch.object(restarted, "resume_all", side_effect=OSError(5, "Input/output error")), \
                mock.patch("builtins.print"), mock.patch("traceback.print_exc"):
            restarted.resume_in_background().join(5)
        self.assertFalse(restarted.resuming)
        restarted.start(request())
        self.assertTrue(self.done(restarted))

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

    def test_shutdown_keeps_a_live_job_threads_reservation(self):
        never = threading.Event()
        stages = FakeStages(ignore_stop=never)  # a thread in a step that does not look at should_stop
        jobs = self.jobs(stages)
        jobs.start(request())
        self.assertTrue(stages.entered.wait(5))
        reserved = jobs.registry.budget.reserved("job-1")
        with mock.patch.object(book_job, "STOP_WAIT_S", 0.2, create=True):
            jobs.shutdown()
        self.assertTrue((self.root / "job-1").exists(), "the folder stays for the resume")
        self.assertEqual(jobs.registry.budget.reserved("job-1"), reserved, "the live thread keeps its bytes")
        self.assertEqual([s["jobId"] for s in jobs.registry.stuck()], ["job-1"])
        never.set()

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
        # #403: the section titles are part of the result (passages and flags), so of the identity too.
        self.assertNotEqual(base, request_digest({**request(), "sections": [{"index": 0, "title": "One"}]}))

    def test_a_folder_of_the_earlier_book_generation_starts_over(self):
        # #403 made book-v2: a retained book-v1 folder (its groups, emissions and result) is not reused.
        self.assertTrue(BOOK_ENGINE.endswith("-book-v2"))
        folder = self.root / "job-1"
        (folder / "groups").mkdir(parents=True)
        (folder / "emissions").mkdir()
        (folder / "groups" / "0.json").write_text(json.dumps({"index": 0}))
        (folder / "emissions" / "0.f16").write_bytes(b"\0" * 58)
        (folder / "result.json").write_text("{}")
        (folder / "request.json").write_text(json.dumps(request()))
        old = BOOK_ENGINE.replace("-book-v2", "-book-v1")
        (folder / "state.json").write_text(json.dumps({
            "jobId": "job-1", "engine": old, "digest": request_digest(request()), "state": "aligning",
            "createdAt": 1.0, "updatedAt": 1.0, "progress": {}, "stageTimings": {}, "error": None, "resumed": 0}))
        stages = FakeStages()
        jobs = self.jobs(stages)
        jobs.resume_all()
        self.assertTrue(self.done(jobs))
        self.assertEqual(stages.aligned, [0, 1, 2, 3])  # group 0 of book-v1 aligned again
        self.assertEqual(jobs.status("job-1")["engine"], BOOK_ENGINE)


class DiskPeaks:
    """Patches Path.replace: before a file under `folder` replaces another (the peak of write_json and of
    write_reserved: the old file and its temporary copy are both there), records (bytes under the folder,
    the key's reservation)."""

    def __init__(self, budget, key, folder):
        self.budget, self.key, self.folder = budget, key, Path(folder)
        self.peaks = []
        self.real = Path.replace
        peaks = self

        def replace(path, target):
            if peaks.folder in Path(path).parents:
                peaks.peaks.append((book_session.folder_bytes(peaks.folder), peaks.budget.reserved(peaks.key)))
            return peaks.real(path, target)

        self.patch = mock.patch.object(Path, "replace", replace)

    def __enter__(self):
        self.patch.start()
        return self

    def __exit__(self, *exc):
        self.patch.stop()

    def over(self):
        return [(used, held) for used, held in self.peaks if used > held]


class ResultStages(FakeStages):
    """Writes a result of about `size` bytes with write_reserved, as the real stages do, or (`own`) after
    reserving it itself: the job's folder, the result's temporary copy and room for the state file."""

    def __init__(self, size, own=False):
        super().__init__()
        self.size = size
        self.own = own

    def run(self, job, session, should_stop):
        self.order.append(job.key)
        result = {"jobId": job.key, "engine": BOOK_ENGINE, "outcome": "unsynced", "intervals": [],
                  "unsyncedPassages": [{"section": 0, "title": "x" * self.size}]}
        if not self.own:
            book_job.write_reserved(job, session, job.folder / "result.json", result, should_stop, STATE)
            return
        text = json.dumps(result, separators=(",", ":"))
        session.reserve_disk(book_session.folder_bytes(job.folder) + len(text) + STATE)
        book_job.write_json(job.folder / "result.json", result)


class ResultDisk(unittest.TestCase):
    """#403 review (blocking): every byte of the result, and of its temporary copy, is reserved first."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "book-jobs"
        self.clock = Clock()
        self.made = []

    def tearDown(self):
        # Stop every job thread before the folder goes: a thread still running records its failure and
        # recreates book-jobs/<job> inside the removed temporary directory, which is then left behind.
        for jobs in self.made:
            jobs.shutdown()
        self.tmp.cleanup()

    def track(self, jobs):
        self.made.append(jobs)
        return jobs

    def job(self, budget, sentences):
        registry = SessionRegistry(DiskBudget(budget), idle=900, clock=self.clock)
        body = {**request(), "sentences": sentences}
        folder = self.root / "job-1"
        folder.mkdir(parents=True)
        book_job.write_json(folder / "request.json", body)
        session = registry.open("job-1", folder)
        job = book_job.Job("job-1", folder, body, request_digest(body),
                           {"jobId": "job-1", "engine": BOOK_ENGINE, "state": "finishing", "progress": {}})
        job.save()
        registry.budget.claim("job-1", book_session.folder_bytes(folder))
        return registry, session, job

    @staticmethod
    def long_titled_result(sections=2000, title="é" * 2000):
        """2,000 sections of two sentences, the first of each mapped: 2,000 passages, each with the section's
        2,000-character title (align.py's limit), six bytes per character as JSON."""
        sentences = [{"id": f"p{k}", "section": k // 2, "text": f"Sentence {k}."} for k in range(2 * sections)]
        titles = {n: title for n in range(sections)}
        mapped = {s["id"] for k, s in enumerate(sentences) if k % 2 == 0}
        passages = book_report.unsynced_passages(sentences, mapped, titles)
        return sentences, {"jobId": "job-1", "engine": BOOK_ENGINE, "outcome": "mapped", "intervals": [],
                           "unsyncedPassages": passages, "flags": []}

    def test_a_result_with_many_long_titles_is_reserved_from_its_real_size_before_it_is_written(self):
        sentences, result = self.long_titled_result()
        self.assertEqual(len(result["unsyncedPassages"]), 2000)
        text = json.dumps(result, separators=(",", ":"))
        # The estimate #402 reserved for all of a book's small files does not bound this result.
        self.assertGreater(len(text), book_session.meta_bytes(len(sentences)))
        registry, session, job = self.job(10 ** 9, sentences)
        with DiskPeaks(registry.budget, "job-1", job.folder) as peaks:
            size = book_job.write_reserved(job, session, job.folder / "result.json", result, lambda: False)
        self.assertEqual(size, len(text))
        self.assertEqual((job.folder / "result.json").read_text(), text)  # write_json's exact text
        self.assertTrue(peaks.peaks)
        self.assertEqual(peaks.over(), [], "the files never exceeded the reservation")
        self.assertGreaterEqual(registry.budget.reserved("job-1"), book_session.folder_bytes(job.folder))
        self.assertEqual(list(job.folder.glob("*.tmp")), [])

    def test_a_result_that_does_not_fit_fails_and_nothing_is_written(self):
        sentences, result = self.long_titled_result()
        size = len(json.dumps(result, separators=(",", ":")))
        registry, session, job = self.job(size, sentences)  # the result alone fills the budget: no room for it
        with self.assertRaises(BudgetExceeded) as caught:
            book_job.write_reserved(job, session, job.folder / "result.json", result, lambda: False)
        self.assertIn(f"result is {size} bytes", str(caught.exception))
        self.assertIn("was not written", str(caught.exception))
        self.assertFalse((job.folder / "result.json").exists())
        self.assertEqual(list(job.folder.glob("*.tmp")), [])

    def test_a_job_whose_result_does_not_fit_fails_with_a_clear_error(self):
        registry = SessionRegistry(DiskBudget(10_000), idle=900, clock=self.clock)
        jobs = self.track(BookJobs(self.root, ResultStages(20_000), registry, clock=self.clock, state_bytes=STATE))
        jobs.start(request())
        self.assertTrue(wait_for(lambda: jobs.status("job-1")["state"] in ("done", "failed")))
        status = jobs.status("job-1")
        self.assertEqual(status["state"], "failed")
        self.assertIn("result is", status["error"])
        self.assertIn("was not written", status["error"])
        self.assertFalse((self.root / "job-1" / "result.json").exists())

    def test_the_finished_result_is_not_written_a_second_time(self):
        # 291bd56 wrote the stages' result.json again when the job finished: a temporary copy of the whole
        # result next to it, which nothing had reserved.
        registry = SessionRegistry(DiskBudget(100_000), idle=900, clock=self.clock)
        jobs = self.track(BookJobs(self.root, ResultStages(20_000, own=True), registry, clock=self.clock, state_bytes=STATE))
        with DiskPeaks(registry.budget, "job-1", self.root / "job-1") as peaks:
            jobs.start(request())
            self.assertTrue(wait_for(lambda: jobs.status("job-1")["state"] in ("done", "failed")))
        self.assertEqual(jobs.status("job-1")["state"], "done")
        self.assertEqual(peaks.over(), [], "the files never exceeded the reservation")
        self.assertEqual(len(jobs.result("job-1")["unsyncedPassages"][0]["title"]), 20_000)

    def test_language_not_supported_reserves_its_result(self):
        registry = SessionRegistry(DiskBudget(10_000), idle=900, clock=self.clock)
        jobs = self.track(BookJobs(self.root, FakeStages(), registry, clock=self.clock, state_bytes=STATE))
        with DiskPeaks(registry.budget, "job-1", self.root / "job-1") as peaks:
            jobs.start({**request(), "language": "spa"})
            self.assertTrue(wait_for(lambda: jobs.status("job-1")["state"] == "done"))
        self.assertEqual(peaks.over(), [])
        self.assertEqual(jobs.result("job-1")["outcome"], "language_not_supported")


if __name__ == "__main__":
    unittest.main()
