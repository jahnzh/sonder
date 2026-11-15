"""Whole-book encode batches share the window endpoints' gate (#402 review): they count in its busy and
slot fields, never run beside a window request when the gate has one slot, and window requests come first.
Standard library only; the encoder itself is faked in test_book_pipeline.py (Gate interleaving with a model).
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

FAST = {"WINDOW_GRACE_S": 0.05, "WINDOW_RETRY_S": 1.0}


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


class BackgroundSlots(unittest.TestCase):
    def test_a_book_batch_counts_in_busy_and_active(self):
        gate = Gate(1)
        with fast_rules(), gate.hold_background():
            self.assertEqual(gate.active, 1)
            self.assertTrue(gate.busy)
            self.assertEqual(gate.background_active, 1)
            self.assertIsNotNone(gate.busy_seconds())
            with self.assertRaises(WorkerBusy):  # a window request is refused, exactly as before
                with gate.hold():
                    pass
        self.assertEqual((gate.active, gate.background_active, gate.busy), (0, 0, False))

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
        refused_at = []
        with fast_rules():
            with gate.hold_background():
                with self.assertRaises(WorkerBusy):
                    with gate.hold():
                        pass
                refused_at.append(time.monotonic())
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
            with gate.hold_background():
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
        # A refused request is served at its next attempt: the book does not take the gate in between.
        for n, refused in window.refusals:
            self.assertEqual(sum(1 for m, _ in window.refusals if m == n), 1, window.refusals)
            served = next(t for m, t in window.served if m == n)
            self.assertFalse(any(refused < start < served for start, _ in batches),
                             "a book batch started while a refused window request waited to retry")
        # Book batches ran between the window requests and never during one.
        first, last = window.served[0][1], window.served[-1][1]
        self.assertTrue(any(first < start < last for start, _ in batches), "the book interleaved")
        for _n, served in window.served:
            self.assertFalse(any(start <= served <= end for start, end in batches))


if __name__ == "__main__":
    unittest.main()
