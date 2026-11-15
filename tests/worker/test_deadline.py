"""Worker deadline tests. Run with `python3 -m unittest discover -s tests/worker`; needs neither fastapi nor aeneas."""
import contextlib
import io
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import deadline  # noqa: E402
from deadline import AlignmentFailed, AlignmentTimeout, Gate, WorkerBusy, alignment_limit, anchor_limit  # noqa: E402

class Limit(unittest.TestCase):
    def test_defaults_scale_with_audio_and_stop_at_the_ceiling(self):
        self.assertEqual(alignment_limit(7200, {}), 1200)
        self.assertEqual(alignment_limit(1800, {}), 390)
        self.assertAlmostEqual(alignment_limit(60, {}), 129)
        self.assertEqual(alignment_limit(100000, {}), 1200)

    def test_anchor_limit_stays_under_the_server_wait(self):
        self.assertAlmostEqual(anchor_limit(60, {}), 129)
        self.assertEqual(anchor_limit(60, {"ALIGNMENT_TIMEOUT_BASE_SECONDS": "1400"}), 150)

    def test_the_anchor_ceiling_plus_the_kill_path_fits_in_the_servers_wait(self):
        # server/alignment.ts waits 180 s for /anchor; the worker's 504 must arrive first, kill path included.
        self.assertLess(deadline.ANCHOR_CEILING + deadline.KILL_WAIT_SECONDS + deadline.REAP_SECONDS, 180)

    def test_environment_overrides_each_value(self):
        self.assertEqual(alignment_limit(100, {"ALIGNMENT_TIMEOUT_BASE_SECONDS": "10"}), 25)
        self.assertEqual(alignment_limit(100, {"ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND": "1"}), 220)
        self.assertEqual(alignment_limit(7200, {"ALIGNMENT_TIMEOUT_MAX_SECONDS": "300"}), 300)

    def test_nonsense_falls_back_to_the_default(self):
        for name, default_limit in [("ALIGNMENT_TIMEOUT_BASE_SECONDS", 135), ("ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND", 135), ("ALIGNMENT_TIMEOUT_MAX_SECONDS", 135)]:
            for bad in ["abc", "nan", "inf", "-5", "", "  ", "1e9", "0" if name.endswith("MAX_SECONDS") else "-0.1"]:
                with self.subTest(name=name, value=bad), contextlib.redirect_stderr(io.StringIO()) as warning:
                    self.assertEqual(alignment_limit(100, {name: bad}), default_limit)
                    self.assertEqual(name in warning.getvalue(), bool(bad.strip()), "an empty value counts as unset and is not reported")

class Deadline(unittest.TestCase):
    def test_a_child_that_survives_the_kill_keeps_the_slot_until_it_is_gone(self):
        gate = Gate()
        with mock.patch.object(deadline, "KILL_WAIT_SECONDS", 0.2), mock.patch.object(deadline, "REAP_SECONDS", 0.2):
            # A kill that does nothing, like SIGKILL on a process stuck in uninterruptible disk sleep.
            with mock.patch.object(deadline.os, "killpg"), mock.patch.object(subprocess.Popen, "kill"):
                with self.assertRaises(AlignmentTimeout) as caught:
                    with gate.hold():
                        deadline.run_with_deadline(["sleep", "300"], time.monotonic() + 0.3, 0.3)
        survivor = caught.exception.stuck
        self.addCleanup(lambda: survivor.poll() is None and os.killpg(survivor.pid, signal.SIGKILL))
        self.assertIsNotNone(survivor, "the timeout reports the process that is still running")
        self.assertTrue(gate.busy and gate.stuck, "the slot stays taken and is reported as stuck")
        self.assertIsNotNone(gate.busy_seconds())
        with self.assertRaises(WorkerBusy):
            with gate.hold():
                pass
        os.killpg(survivor.pid, signal.SIGKILL)
        for _ in range(100):
            if not gate.busy:
                break
            time.sleep(0.05)
        self.assertFalse(gate.busy, "the slot is freed once the process is really gone")
        self.assertFalse(gate.stuck)
        self.assertIsNone(gate.busy_seconds())
        with gate.hold():
            pass

try:
    import fastapi  # noqa: F401
    import pydantic  # noqa: F401
except ImportError:
    fastapi = None

@unittest.skipIf(fastapi is None, "fastapi is not installed here; the worker image has it")
class Http(unittest.TestCase):
    """The endpoint mapping the server relies on: a timeout is 504, busy is 409, anything else is 422."""
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        os.environ["MEDIA_ROOT"] = str(cls.root)
        os.environ["ALIGNMENT_WORKER_TOKEN"] = "secret"
        os.environ.pop("MEDIA_VOLUME_ID", None)
        (cls.root / "alignment").mkdir()
        (cls.root / "book.m4b").write_bytes(b"x")
        import align
        cls.align = align

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def align_request(self):
        return self.align.AlignRequest(token="secret", audio=str(self.root / "book.m4b"), output=str(self.root / "alignment" / "s" / "out.json"),
                                       fragments=["One."], duration=60)

    def anchor_request(self):
        return self.align.AnchorRequest(token="secret", audio=str(self.root / "book.m4b"), output=str(self.root / "alignment" / "o.json"),
                                        fragments=["One."], duration=30)

    def status_of(self, call, request, target, effect):
        with mock.patch.object(self.align, target, side_effect=effect), contextlib.redirect_stderr(io.StringIO()) as log:
            with self.assertRaises(self.align.HTTPException) as caught:
                call(request)
        return caught.exception.status_code, str(caught.exception.detail), log.getvalue()

    def test_a_timeout_is_504_on_both_endpoints(self):
        for call, request, target in [(self.align.align, self.align_request(), "align_ctc_section"), (self.align.anchor, self.anchor_request(), "align_ctc_section")]:
            with self.subTest(target=target):
                status, detail, _ = self.status_of(call, request, target, AlignmentTimeout(5))
                self.assertEqual(status, 504)
                self.assertIn("timed out", detail)

    def test_worker_failure_responses_include_metadata(self):
        for call, request, target in [(self.align.align, self.align_request(), "align_ctc_section"), (self.align.anchor, self.anchor_request(), "align_ctc_section")]:
            with self.subTest(target=target), mock.patch.object(self.align, target, side_effect=AlignmentTimeout(5)):
                with self.assertRaises(self.align.HTTPException) as caught:
                    call(request)
                detail = caught.exception.detail
                self.assertEqual(detail["engine"], self.align.CTC_ENGINE)
                self.assertEqual(detail["outcome"], "error")
                self.assertGreaterEqual(detail["stageTimings"]["failedRequest"], 0)

    def test_a_busy_worker_is_409_and_other_failures_are_422_with_a_log_line(self):
        with self.align.gate.hold():
            status, _, _ = self.status_of(self.align.align, self.align_request(), "align_ctc_section", AlignmentTimeout(5))
        self.assertEqual(status, 409)
        status, _, log = self.status_of(self.align.align, self.align_request(), "align_ctc_section", AlignmentFailed("decoder failed"))
        self.assertEqual(status, 422)
        self.assertIn("decoder failed", log, "the worker log says why, the response does not")

    def test_health_reports_a_stuck_job(self):
        self.assertEqual(set(self.align.health()) >= {"busy", "stuck", "busySeconds", "lastTimeout"}, True)
        self.assertTrue(self.align.health()["ctc"]["passageReady"])

    def test_unsupported_language_is_explicit_for_both_endpoints(self):
        for call, request in [(self.align.align, self.align_request()), (self.align.anchor, self.anchor_request())]:
            request.language = "jpn"
            result = call(request)
            self.assertEqual(result["engine"], self.align.CTC_ENGINE)
            self.assertEqual(result["outcome"], "language_not_supported")
            self.assertGreaterEqual(result["stageTimings"]["requestValidation"], 0)

    def test_ctc_is_the_default(self):
        request = self.align_request()
        self.assertEqual(request.engine, "ctc")
        request.engine = "ctc"
        request.recordingId = "recording"
        request.audioFingerprint = "audio-version"
        request.trackId = "track"
        fake = {"engine": self.align.CTC_ENGINE, "outcome": "mapped", "intervals": []}
        with mock.patch.object(self.align, "align_ctc_section", return_value=fake) as ctc:
            self.assertEqual(self.align.align(request), fake)
            ctc.assert_called_once()
            self.assertEqual({key: ctc.call_args.kwargs[key] for key in ("recording_id", "recording_fingerprint", "track_id")},
                             {"recording_id": "recording", "recording_fingerprint": "audio-version", "track_id": "track"})
        request.language = "fra"
        self.assertEqual(self.align.align(request)["outcome"], "language_not_supported")
        self.assertEqual(self.align.align(request)["engine"], self.align.CTC_ENGINE)

    def test_a_retired_engine_is_refused_by_request_validation(self):
        # An older server may still name aeneas (#279). FastAPI answers a failed body validation with 422,
        # so the caller gets a clear error instead of a CTC run it did not ask for.
        from pydantic import ValidationError
        for model, extra in ((self.align.AlignRequest, {"duration": 60}),
                             (self.align.AnchorRequest, {"duration": 30})):
            with self.assertRaises(ValidationError) as caught:
                model(token="secret", audio=str(self.root / "book.m4b"), output=str(self.root / "alignment" / "x.json"),
                      fragments=["One."], engine="aeneas", **extra)
            self.assertIn("engine", str(caught.exception))

    def test_ctc_failures_report_the_ctc_engine(self):
        request = self.align_request()
        request.engine = "ctc"
        with mock.patch.object(self.align, "align_ctc_section", side_effect=AlignmentTimeout(5)):
            with self.assertRaises(self.align.HTTPException) as caught:
                self.align.align(request)
        self.assertEqual(caught.exception.status_code, 504)
        self.assertEqual(caught.exception.detail["engine"], self.align.CTC_ENGINE)

    def test_ctc_anchor_reuses_recording_identity_and_rejects_other_languages(self):
        request = self.anchor_request()
        request.engine = "ctc"
        request.recordingId = "recording"
        request.audioFingerprint = "audio-version"
        request.trackId = "track"
        fake = {"engine": self.align.CTC_ENGINE, "outcome": "mapped", "match": {"index": 0}}
        with mock.patch.object(self.align, "align_ctc_section", return_value=fake) as ctc:
            self.assertEqual(self.align.anchor(request), fake)
            self.assertTrue(ctc.call_args.kwargs["locate"])
            self.assertEqual({key: ctc.call_args.kwargs[key] for key in ("recording_id", "recording_fingerprint", "track_id")},
                             {"recording_id": "recording", "recording_fingerprint": "audio-version", "track_id": "track"})
            request.language = "fra"
            result = self.align.anchor(request)
            self.assertEqual(result["outcome"], "language_not_supported")
            self.assertEqual(result["engine"], self.align.CTC_ENGINE)
            ctc.assert_called_once()

class GateState(unittest.TestCase):
    def test_a_second_holder_is_refused_and_the_age_is_reported(self):
        gate = Gate()
        self.assertFalse(gate.busy)
        self.assertIsNone(gate.busy_seconds())
        with gate.hold():
            self.assertTrue(gate.busy)
            self.assertIsNotNone(gate.busy_seconds())
            with self.assertRaises(WorkerBusy):
                with gate.hold():
                    pass
        self.assertFalse(gate.busy)
        self.assertIsNone(gate.last_timeout)

    def test_the_age_is_never_reported_for_a_free_gate(self):
        gate = Gate()
        with gate.hold():
            pass
        self.assertIsNone(gate.busy_seconds())

    def test_the_gate_is_released_when_the_job_raises(self):
        gate = Gate()
        with self.assertRaises(RuntimeError):
            with gate.hold():
                raise RuntimeError("boom")
        with gate.hold():
            pass

    def test_a_gate_with_slots_admits_that_many_and_reports_the_oldest_age(self):
        gate = Gate(3)
        with gate.hold():
            with gate.hold():
                self.assertFalse(gate.busy, "a slot is still free")
                self.assertEqual(gate.active, 2)
                with gate.hold():
                    self.assertTrue(gate.busy)
                    with self.assertRaises(WorkerBusy):
                        with gate.hold():
                            pass
                self.assertFalse(gate.busy)
            self.assertIsNotNone(gate.busy_seconds())
        self.assertEqual(gate.active, 0)
        self.assertIsNone(gate.busy_seconds())

    def test_slots_come_from_the_environment_and_bad_values_fall_back_to_one(self):
        from deadline import worker_slots
        self.assertEqual(worker_slots({}), 1)
        self.assertEqual(worker_slots({"ALIGNMENT_WORKER_SLOTS": "4"}), 4)
        for bad in ("0", "17", "two", ""):
            self.assertEqual(worker_slots({"ALIGNMENT_WORKER_SLOTS": bad}), 1)

if __name__ == "__main__":
    unittest.main()
