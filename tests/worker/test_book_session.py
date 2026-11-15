"""Per-book sessions (#391, #402): disk budget, release on every exit, idle end. Standard library only."""
import sys
import tempfile
import threading
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from book_session import (BudgetExceeded, DiskBudget, SessionEnded, SessionRegistry, estimate_bytes)


class FakePool:
    def __init__(self):
        self.shutdowns = []

    def shutdown(self, wait=True, cancel_futures=False):
        self.shutdowns.append((wait, cancel_futures))


class FakeProcess:
    """A pool process that ignores SIGTERM unless told otherwise; records what was still there when it exited."""

    def __init__(self, folder, budget, key, obeys_terminate=False):
        self.folder, self.budget, self.key = folder, budget, key
        self.obeys_terminate = obeys_terminate
        self.signals = []
        self.alive = True
        self.seen_at_exit = None

    def terminate(self):
        self.signals.append("TERM")
        if self.obeys_terminate:
            self._exit()

    def kill(self):
        self.signals.append("KILL")
        self._exit()

    def _exit(self):
        if self.alive:
            self.alive = False
            self.seen_at_exit = {"emissions": (self.folder / "emissions").exists(),
                                 "reserved": self.budget.reserved(self.key)}

    def is_alive(self):
        return self.alive

    def join(self, timeout=None):
        pass


class StuckProcess(FakeProcess):
    """A process in uninterruptible I/O: it survives SIGKILL, and a join without a timeout never returns."""

    def __init__(self, folder, budget, key):
        super().__init__(folder, budget, key)
        self.gone = threading.Event()

    def kill(self):
        self.signals.append("KILL")

    def is_alive(self):
        return not self.gone.is_set()

    def join(self, timeout=None):
        self.gone.wait(timeout)


class ProcessPool(FakePool):
    """FakePool with the processes a ProcessPoolExecutor keeps in `_processes` (pid -> Process)."""

    def __init__(self, processes):
        super().__init__()
        self._processes = {i: p for i, p in enumerate(processes)}

    def shutdown(self, wait=True, cancel_futures=False):
        super().shutdown(wait, cancel_futures)
        self._processes = None  # as ProcessPoolExecutor.shutdown does


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Budget(unittest.TestCase):
    def test_reservations_share_one_budget(self):
        budget = DiskBudget(100)
        self.assertTrue(budget.reserve("a", 60))
        self.assertFalse(budget.reserve("b", 50), "a second book that does not fit waits")
        self.assertTrue(budget.reserve("b", 40))
        self.assertEqual(budget.reserved(), 100)
        self.assertEqual(budget.release("a"), 60)
        self.assertTrue(budget.reserve("c", 60))

    def test_a_book_larger_than_the_budget_fails_at_once(self):
        with self.assertRaises(BudgetExceeded):
            DiskBudget(100).reserve("a", 101)

    def test_re_reserving_replaces_the_own_reservation(self):
        budget = DiskBudget(100)
        budget.reserve("a", 90)
        self.assertTrue(budget.reserve("a", 95))
        self.assertEqual(budget.reserved(), 95)

    def test_lowering_a_reservation_never_waits(self):
        budget = DiskBudget(100)
        budget.claim("a", 80)
        budget.claim("b", 60)  # retained files over the budget after a restart
        self.assertTrue(budget.reserve("a", 50))
        self.assertEqual(budget.reserved("a"), 50)

    def test_raising_is_in_turn_and_fails_when_it_can_never_fit(self):
        budget = DiskBudget(100)
        budget.claim("a", 40)
        budget.claim("b", 40)
        budget.wait_turn("a")
        budget.wait_turn("b")
        self.assertFalse(budget.reserve("b", 50), "b waits behind a")
        with self.assertRaises(BudgetExceeded) as raised:
            budget.reserve("a", 70)  # 70 + b's 40, which b releases only after a
        self.assertIn("never fit", str(raised.exception))
        budget.leave_turn("a")
        budget.release("a")
        self.assertTrue(budget.reserve("b", 70))

    def test_a_parked_reservation_counts_as_held(self):
        budget = DiskBudget(100)
        budget.claim("retained", 40)
        budget.park("retained")
        budget.wait_turn("a")
        with self.assertRaises(BudgetExceeded):
            budget.reserve("a", 70)
        budget.unpark("retained")
        self.assertFalse(budget.reserve("a", 70), "now it only waits")

    def test_a_new_request_is_refused_when_it_does_not_fit_now(self):
        import book_session
        budget = DiskBudget(100)
        budget.reserve("a", 90)
        with self.assertRaises(book_session.DiskFull):
            budget.fits_now("b", 20)
        self.assertEqual(budget.reserved("b"), 0)
        budget.fits_now("b", 10)
        self.assertEqual(budget.reserved("b"), 10)

    def test_estimate_covers_pcm_and_emissions(self):
        hour = estimate_bytes(3600)
        self.assertGreater(hour, 3600 * 32000)  # PCM alone is 115.2 MB per audio hour
        self.assertLess(hour, 3600 * 45000)


class Sessions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name) / "job"
        (self.folder / "tracks").mkdir(parents=True)
        (self.folder / "emissions").mkdir()
        self.clock = Clock()
        self.registry = SessionRegistry(DiskBudget(10_000), idle=900, clock=self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def held(self):
        session = self.registry.open("job", self.folder)
        session.reserve_disk(4000)
        pcm = self.folder / "tracks" / "0.pcm"
        pcm.write_bytes(b"\0" * 100)
        (self.folder / "emissions" / "0.f16").write_bytes(b"\0" * 58)
        session.add_decoded(0, pcm, "digest")
        session.emissions = object()
        pool = FakePool()
        session.set_pool(pool)
        closed = []
        session.on_end(closed.append)
        return session, pool, closed

    def assert_released(self, session, pool, closed, reason, deleted=True):
        self.assertEqual(session.ended, reason)
        self.assertEqual(pool.shutdowns, [(False, True)])
        self.assertEqual(closed, [reason])
        self.assertIsNone(session.emissions)
        self.assertIsNone(session.pool)
        self.assertEqual(session.decoded, {})
        self.assertEqual(self.registry.budget.reserved(), 0)
        self.assertIsNone(self.registry.get("job"))
        self.assertEqual((self.folder / "tracks").exists(), not deleted)
        self.assertEqual((self.folder / "emissions").exists(), not deleted)

    def test_release_on_result_fetched(self):
        session, pool, closed = self.held()
        self.assertTrue(self.registry.end("job", "fetched"))
        self.assert_released(session, pool, closed, "fetched")

    def test_release_on_cancel(self):
        session, pool, closed = self.held()
        self.registry.end("job", "cancelled")
        self.assert_released(session, pool, closed, "cancelled")

    def test_release_on_failure(self):
        session, pool, closed = self.held()
        self.registry.end("job", "failed")
        self.assert_released(session, pool, closed, "failed")

    def test_release_on_worker_stop_keeps_the_folder_for_resume(self):
        session, pool, closed = self.held()
        self.registry.close_all("worker stop")
        self.assert_released(session, pool, closed, "worker stop", deleted=False)
        self.assertTrue((self.folder / "emissions" / "0.f16").is_file())

    def test_ends_exactly_once(self):
        session, pool, closed = self.held()
        self.assertTrue(self.registry.end("job", "cancelled"))
        self.assertFalse(self.registry.end("job", "fetched"))
        self.assertFalse(session._end("idle", True))
        self.assertEqual(session.ended, "cancelled")
        self.assertEqual(closed, ["cancelled"])

    def test_idle_end_after_fifteen_minutes_without_a_request(self):
        session, pool, closed = self.held()
        self.clock.now += 899
        self.assertEqual(self.registry.idle_keys(), [])
        session.touch()  # a progress request
        self.clock.now += 899
        self.assertEqual(self.registry.idle_keys(), [])
        self.clock.now += 1
        self.assertEqual(self.registry.idle_keys(), ["job"])
        self.registry.end("job", "idle")
        self.assert_released(session, pool, closed, "idle")

    def test_default_idle_time_is_fifteen_minutes(self):
        self.assertEqual(SessionRegistry(DiskBudget(1)).idle, 900)

    def test_work_after_the_end_raises(self):
        session, _pool, _closed = self.held()
        self.registry.end("job", "cancelled")
        with self.assertRaises(SessionEnded):
            session.check()
        late = FakePool()
        with self.assertRaises(SessionEnded):
            session.set_pool(late)
        self.assertEqual(late.shutdowns, [(False, True)], "a pool opened after the end is closed at once")

    def test_waiting_for_budget_stops_when_cancelled(self):
        other = self.registry.open("other", self.folder.parent / "other")
        other.reserve_disk(9000)
        session = self.registry.open("job", self.folder)
        stop = threading.Event()
        errors = []

        def wait():
            try:
                session.reserve_disk(4000, should_wait=lambda: not stop.is_set(), poll=0.01)
            except SessionEnded as error:
                errors.append(error)

        thread = threading.Thread(target=wait)
        thread.start()
        stop.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(self.registry.budget.reserved("job"), 0)

    def test_waiting_book_gets_the_budget_when_another_session_ends(self):
        other = self.registry.open("other", self.folder.parent / "other")
        other.reserve_disk(9000)
        session = self.registry.open("job", self.folder)
        done = threading.Event()

        def wait():
            session.reserve_disk(4000, poll=0.01)
            done.set()

        thread = threading.Thread(target=wait)
        thread.start()
        self.assertFalse(done.wait(0.1))
        self.registry.end("other", "fetched")
        self.assertTrue(done.wait(5))
        thread.join(5)
        self.assertEqual(self.registry.budget.reserved("job"), 4000)

    def test_ending_stops_the_pool_processes_before_deleting_and_releasing(self):
        import book_session
        for reason in ("cancelled", "idle", "worker stop"):
            with self.subTest(reason=reason):
                (self.folder / "tracks").mkdir(parents=True, exist_ok=True)
                (self.folder / "emissions").mkdir(exist_ok=True)
                session = self.registry.open("job", self.folder)
                session.reserve_disk(4000)
                stubborn = FakeProcess(self.folder, self.registry.budget, "job")
                polite = FakeProcess(self.folder, self.registry.budget, "job", obeys_terminate=True)
                pool = ProcessPool([stubborn, polite])
                session.set_pool(pool)
                with unittest.mock.patch.object(book_session, "TERMINATE_GRACE_S", 0.01, create=True):
                    if reason == "worker stop":
                        self.registry.close_all(reason)
                    else:
                        self.registry.end("job", reason)
                self.assertFalse(stubborn.alive or polite.alive, "no group process outlives its session")
                self.assertEqual(stubborn.signals, ["TERM", "KILL"], "killed after the grace time")
                self.assertEqual(polite.signals, ["TERM"])
                for process in (stubborn, polite):
                    self.assertEqual(process.seen_at_exit, {"emissions": True, "reserved": 4000},
                                     "the folder and the reservation outlive the processes")
                self.assertEqual(self.registry.budget.reserved(), 0)

    def stuck_session(self):
        import book_session
        session = self.registry.open("job", self.folder)
        session.reserve_disk(4000)
        process = StuckProcess(self.folder, self.registry.budget, "job")
        pool = ProcessPool([process])
        session.set_pool(pool)
        patches = [unittest.mock.patch.object(book_session, "TERMINATE_GRACE_S", 0.05, create=True),
                   unittest.mock.patch.object(book_session, "KILL_WAIT_S", 0.05, create=True)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(process.gone.set)
        return session, pool, process

    def end_in_thread(self, *args):
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(self.registry.end(*args)), daemon=True)
        thread.start()
        thread.join(10)
        self.assertFalse(thread.is_alive(), "ending a session waits a bounded time for its processes")
        return outcome[0]

    def test_a_process_that_survives_the_kill_keeps_the_folder_and_the_reservation(self):
        session, _pool, process = self.stuck_session()
        self.assertEqual(self.end_in_thread("job", "cancelled"), "stuck")
        self.assertEqual(process.signals, ["TERM", "KILL"])
        self.assertTrue((self.folder / "emissions").exists(), "the folder is kept while the process is there")
        self.assertEqual(self.registry.budget.reserved("job"), 4000, "and so is its reservation")
        self.assertEqual([(s["jobId"], s["reason"], s["reservedBytes"]) for s in self.registry.stuck()],
                         [("job", "cancelled", 4000)])
        self.assertTrue(self.registry.is_stuck("job"))
        self.assertEqual(self.registry.retry_stuck(), [], "still there")
        process.gone.set()  # the read returned and the process died
        self.assertEqual(self.registry.retry_stuck(), ["job"])
        self.assertFalse(self.folder.exists())
        self.assertEqual(self.registry.budget.reserved(), 0)
        self.assertEqual(self.registry.stuck(), [])
        self.assertEqual(session.ended, "cancelled")

    def test_the_jobs_own_stop_of_its_pool_does_not_hide_a_live_process(self):
        # The job thread stops its pool when it stops (release_pool); an end right after must still see the
        # process that did not exit, and keep the folder and the reservation.
        session, pool, process = self.stuck_session()
        stopped = []
        thread = threading.Thread(target=lambda: stopped.append(session.release_pool(pool, stop=True)), daemon=True)
        thread.start()
        thread.join(10)
        self.assertFalse(thread.is_alive(), "the job's stop is bounded too")
        self.assertEqual(stopped, [False])
        self.assertIs(session.pool, pool, "the session keeps a pool whose process is still there")
        self.assertEqual(self.end_in_thread("job", "cancelled"), "stuck")
        self.assertTrue(self.folder.exists())
        self.assertEqual(self.registry.budget.reserved("job"), 4000)
        process.gone.set()
        self.assertEqual(self.registry.retry_stuck(), ["job"])
        self.assertEqual(self.registry.budget.reserved(), 0)

    def test_a_busy_job_thread_keeps_the_session_too(self):
        session = self.registry.open("job", self.folder)
        session.reserve_disk(4000)
        running = threading.Event()
        running.set()
        self.assertEqual(self.registry.end("job", "idle", True, running.is_set), "stuck")
        self.assertTrue(self.folder.exists())
        running.clear()
        self.assertEqual(self.registry.retry_stuck(), ["job"])
        self.assertFalse(self.folder.exists())
        self.assertEqual(self.registry.budget.reserved(), 0)

    def test_drop_decoded_deletes_one_track(self):
        session, _pool, _closed = self.held()
        session.drop_decoded(0)
        self.assertFalse((self.folder / "tracks" / "0.pcm").exists())
        self.assertEqual(session.digests, {0: "digest"})


if __name__ == "__main__":
    unittest.main()
