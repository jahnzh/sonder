"""Per-book sessions (#391, #402): disk budget, release on every exit, idle end. Standard library only."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from book_session import (BudgetExceeded, DiskBudget, SessionEnded, SessionRegistry, estimate_bytes)


class FakePool:
    def __init__(self):
        self.shutdowns = []

    def shutdown(self, wait=True, cancel_futures=False):
        self.shutdowns.append((wait, cancel_futures))


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

    def test_drop_decoded_deletes_one_track(self):
        session, _pool, _closed = self.held()
        session.drop_decoded(0)
        self.assertFalse((self.folder / "tracks" / "0.pcm").exists())
        self.assertEqual(session.digests, {0: "digest"})


if __name__ == "__main__":
    unittest.main()
