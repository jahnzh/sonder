"""Whole-book encode batches share the window endpoints' gate (#402 reviews): a batch holds a slot, but the
gate's window fields (`active`, `busy`, `busy_seconds`, `stuck`, what /health reports) describe window
requests only, a window request that arrives during a batch waits for that one batch instead of being
refused, and no batch starts while a window request runs or waits. Standard library only; the encoder
itself is faked in test_book_pipeline.py (Gate interleaving with a model).
"""
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import deadline
from deadline import Gate, WorkerBusy

FAST = {"WINDOW_GRACE_S": 0.05, "WINDOW_RETRY_S": 1.0, "WINDOW_WAIT_MAX_S": 5.0}


def fast_rules():
    return mock.patch.multiple(deadline, create=True, **FAST)


class Window:
    """A window client like the server's: a sequence of requests, each retried after `retry` s on 409."""

    def __init__(self, gate, requests, hold=0.02, think=0.01, retry=0.15):
        self.gate, self.requests, self.hold, self.think, self.retry = gate, requests, hold, think, retry
        self.refusals = []
        self.served = []
        self.thread = threading.Thread(target=self.run)

    def run(self):
        for n in range(self.requests):
            while True:
                try:
                    with self.gate.hold():
                        self.served.append((n, time.monotonic()))
                        time.sleep(self.hold)
                    break
                except WorkerBusy:
                    self.refusals.append((n, time.monotonic()))
                    time.sleep(self.retry)
            time.sleep(self.think)


def batch_in_thread(gate, seconds, **kwargs):
    """One book batch of `seconds` in its own thread; returns (thread, entered event)."""
    entered = threading.Event()

    def book():
        with gate.hold_background(**kwargs):
            entered.set()
            time.sleep(seconds)

    thread = threading.Thread(target=book)
    thread.start()
    return thread, entered


class BackgroundSlots(unittest.TestCase):
    def test_a_book_batch_is_not_in_the_window_fields(self):
        gate = Gate(1)
        idle = (gate.active, gate.busy, gate.busy_seconds(), gate.stuck)
        with fast_rules(), gate.hold_background():
            self.assertEqual((gate.active, gate.busy, gate.busy_seconds(), gate.stuck), idle,
                             "the window fields read the same with a book batch on the device")
            self.assertEqual(gate.background_active, 1)
            self.assertIsNotNone(gate.background_seconds())
        self.assertEqual((gate.active, gate.background_active, gate.busy), (0, 0, False))

    def test_a_window_request_that_arrives_during_a_batch_waits_for_it(self):
        gate = Gate(1)
        with fast_rules():
            thread, entered = batch_in_thread(gate, 0.3)
            self.assertTrue(entered.wait(2))
            arrived = time.monotonic()
            with gate.hold():  # not refused
                waited = time.monotonic() - arrived
                self.assertEqual(gate.background_active, 0, "the window request runs after the batch, not beside it")
                self.assertEqual((gate.active, gate.busy), (1, True))
            thread.join(2)
        self.assertGreater(waited, 0.1)
        self.assertLess(waited, 0.3 + 0.5, "at most one batch")

    def test_window_requests_that_fill_every_slot_are_refused_as_before(self):
        gate = Gate(1)
        with fast_rules(), gate.hold():
            with self.assertRaises(WorkerBusy):
                with gate.hold():
                    pass

    def test_no_batch_starts_while_a_window_request_waits(self):
        gate = Gate(1)
        batches = []

        def book():
            for _ in range(3):
                with gate.hold_background():
                    start = time.monotonic()
                    time.sleep(0.2)
                    batches.append((start, time.monotonic()))

        with fast_rules():
            thread = threading.Thread(target=book)
            thread.start()
            while not batches and gate.background_active == 0:
                time.sleep(0.005)
            arrived = time.monotonic()
            with gate.hold():
                served = time.monotonic()
                time.sleep(0.05)
            ended = time.monotonic()
            thread.join(5)
        self.assertLess(served - arrived, 0.2 + 0.3, "served within one batch")
        self.assertFalse(any(arrived < start < ended for start, _ in batches),
                         "no batch started while the window request waited or ran")

    def test_a_hung_batch_refuses_a_waiting_window_request_after_the_wait_limit(self):
        gate = Gate(1)
        with fast_rules(), mock.patch.object(deadline, "WINDOW_WAIT_MAX_S", 0.2):
            thread, entered = batch_in_thread(gate, 1.0)
            self.assertTrue(entered.wait(2))
            started = time.monotonic()
            with self.assertRaises(WorkerBusy):
                with gate.hold():
                    pass
            self.assertLess(time.monotonic() - started, 0.8)
            self.assertEqual(gate.active, 0, "the refused request holds no slot")
            thread.join(3)

    def test_the_holder_is_told_when_it_waits(self):
        gate = Gate(1)
        events = []
        with fast_rules():
            with gate.hold():
                thread, entered = batch_in_thread(gate, 0.0, on_wait=events.append)
                time.sleep(0.2)
                self.assertEqual(events, [True])
            self.assertTrue(entered.wait(2))
            thread.join(2)
        self.assertEqual(events, [True, False])
        with fast_rules():
            quiet = []
            time.sleep(0.1)
            with gate.hold_background(on_wait=quiet.append):
                pass
        self.assertEqual(quiet, [], "no report when the slot is free at once")

    def test_a_failing_wait_report_neither_leaks_the_slot_nor_reaches_the_batch(self):
        # The review's reproduction: a window request holds the gate, the book's batch waits, and its
        # wait report (a state.json write) raises once the batch has the slot. The batch still runs, the
        # slot is freed, and the next window request is served at once, not after WINDOW_WAIT_MAX_S.
        for failing in (False, True):  # the report of the wait's end (the review's case), then of its start
            gate = Gate(1)
            ran, errors = [], []

            def report(waiting, failing=failing):
                if waiting is failing:
                    raise OSError(28, "No space left on device")

            def book():
                try:
                    with gate.hold_background(on_wait=report, poll=0.01):
                        ran.append(gate.background_active)
                except Exception as error:  # noqa: BLE001 - the test reports what reached the batch
                    errors.append(error)

            with fast_rules(), mock.patch("builtins.print"):
                with gate.hold():
                    thread = threading.Thread(target=book)
                    thread.start()
                    time.sleep(0.1)
                thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertEqual((errors, ran), ([], [1]), f"the batch runs (report {failing} failed)")
                self.assertEqual(gate.background_active, 0, "the batch's slot is free again")
                started = time.monotonic()
                with gate.hold():
                    pass
                self.assertLess(time.monotonic() - started, 0.5, "the next window request is not held up")

    def test_a_status_write_that_never_returns_holds_no_slot(self):
        # The round-4 review's probe: a book waits behind a window request, the gate frees up, and the
        # book's "no longer waiting" report (a state.json write) blocks. Before the fix the book held the
        # slot during that write, so the next window request waited WINDOW_WAIT_MAX_S and got 409 while no
        # batch had started. Now no report runs while the book holds a slot.
        gate = Gate(1)
        release = threading.Event()
        reports, batches = [], []

        def report(waiting):
            reports.append((waiting, gate.background_active))
            if not waiting and len(reports) == 2:
                release.wait(5)  # the first "no longer waiting" write hangs

        def book():
            with gate.hold_background(on_wait=report, poll=0.01):
                batches.append(gate.background_active)

        rules = {**FAST, "WINDOW_GRACE_S": 0.0, "WINDOW_RETRY_S": 0.0, "WINDOW_WAIT_MAX_S": 0.15}
        with mock.patch.multiple(deadline, create=True, **rules):
            thread = threading.Thread(target=book)
            with gate.hold():
                thread.start()
                time.sleep(0.1)
            deadline_at = time.monotonic() + 2
            while len(reports) < 2 and time.monotonic() < deadline_at:
                time.sleep(0.01)
            self.assertEqual([waiting for waiting, _ in reports], [True, False], "the book reports its wait's end")
            try:
                with gate.hold():  # the window request that came after: served, not refused
                    outcome = "served"
                    self.assertEqual((batches, gate.background_active), ([], 0), "no batch and no slot taken")
            except WorkerBusy:
                outcome = "409"
            finally:
                release.set()
            self.assertEqual(outcome, "served")
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(batches, [1], "the batch runs once the window request is done")
        self.assertEqual([held for _, held in reports], [0] * len(reports), "no report while a slot is held")
        self.assertEqual(reports[-1][0], False)
        self.assertEqual(gate.background_active, 0)

    def test_the_slot_is_freed_on_every_exit_after_it_was_taken(self):
        gate = Gate(1)

        def report(waiting):
            if not waiting:  # the report of the wait's end (just before the slot is taken)
                raise KeyboardInterrupt()  # not an Exception: it reaches the caller, and no slot stays held

        caught = []

        def book():
            try:
                with gate.hold_background(on_wait=report, poll=0.01):
                    pass
            except KeyboardInterrupt:
                caught.append(True)

        with fast_rules():
            with gate.hold():
                thread = threading.Thread(target=book)
                thread.start()
                time.sleep(0.05)
            thread.join(2)
        self.assertEqual(caught, [True])
        self.assertEqual(gate.background_active, 0)

    def test_a_book_batch_waits_while_a_window_request_runs(self):
        gate = Gate(2)  # even with a free slot
        entered = threading.Event()

        def book():
            with gate.hold_background():
                entered.set()

        with fast_rules():
            with gate.hold():
                thread = threading.Thread(target=book)
                thread.start()
                self.assertFalse(entered.wait(0.2))
            ended = time.monotonic()
            self.assertTrue(entered.wait(2))
            self.assertGreaterEqual(time.monotonic() - ended, FAST["WINDOW_GRACE_S"] * 0.9,
                                    "the next request of a window job gets the grace time first")
            thread.join(2)

    def test_a_refused_window_request_gets_in_before_the_next_book_batch(self):
        gate = Gate(1)
        with fast_rules():
            with gate.hold():  # a window request holds the one slot; a second one is refused
                with self.assertRaises(WorkerBusy):
                    with gate.hold():
                        pass
            entered = threading.Event()

            def book():
                with gate.hold_background():
                    entered.set()

            thread = threading.Thread(target=book)
            thread.start()
            self.assertFalse(entered.wait(0.3), "the book waits for the refused request to come back")
            with gate.hold():  # the retry
                pass
            self.assertTrue(entered.wait(2))
            thread.join(2)

    def test_a_refused_request_that_never_returns_holds_the_book_up_only_for_a_while(self):
        gate = Gate(1)
        with fast_rules():
            with gate.hold():
                with self.assertRaises(WorkerBusy):
                    with gate.hold():
                        pass
            started = time.monotonic()
            with gate.hold_background():
                waited = time.monotonic() - started
        self.assertGreaterEqual(waited, FAST["WINDOW_RETRY_S"] * 0.9)
        self.assertLess(waited, FAST["WINDOW_RETRY_S"] + 1.0)

    def test_waiting_for_the_gate_stops_when_the_job_is_cancelled(self):
        gate = Gate(1)
        stop = threading.Event()
        errors = []

        def book():
            try:
                with gate.hold_background(stop.is_set):
                    pass
            except deadline.GateWaitStopped as error:
                errors.append(error)

        with fast_rules(), gate.hold():
            thread = threading.Thread(target=book)
            thread.start()
            stop.set()
            thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertEqual((gate.active, gate.background_active), (0, 0), "a stopped wait holds no slot")

    @staticmethod
    def run_book(gate, batches, count, seconds=0.01):
        for _ in range(count):
            with gate.hold_background():
                start = time.monotonic()
                time.sleep(seconds)
                batches.append((start, time.monotonic()))

    def test_a_window_job_with_short_gaps_keeps_the_book_out(self):
        gate = Gate(1)
        batches = []
        window = Window(gate, requests=8, think=0.01)  # gaps shorter than WINDOW_GRACE_S
        with fast_rules():
            window.thread.start()
            time.sleep(0.005)
            book = threading.Thread(target=self.run_book, args=(gate, batches, 5))
            book.start()
            window.thread.join(10)
            book.join(10)
        last = window.served[-1][1]
        self.assertEqual(len(batches), 5)
        self.assertTrue(all(start > last for start, _ in batches), "no batch ran while the window job lasted")

    def test_book_batches_and_a_window_job_interleave_with_windows_first(self):
        gate = Gate(1)
        batches = []
        window = Window(gate, requests=6, think=0.12)  # gaps longer than WINDOW_GRACE_S

        with fast_rules():
            window.thread.start()
            self.run_book(gate, batches, 60)
            window.thread.join(10)
        self.assertEqual([n for n, _ in window.served], list(range(6)), "every window request was served")
        self.assertEqual(window.refusals, [], "a book batch never makes a window request refused")
        # Book batches ran between the window requests and never during one.
        first, last = window.served[0][1], window.served[-1][1]
        self.assertTrue(any(first < start < last for start, _ in batches), "the book interleaved")
        for _n, served in window.served:
            self.assertFalse(any(start <= served <= end for start, end in batches))


if __name__ == "__main__":
    unittest.main()
