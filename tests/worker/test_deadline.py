"""Worker deadline tests. Run with `python3 -m unittest discover -s tests/worker`; needs neither fastapi nor aeneas."""
import contextlib
import io
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import deadline  # noqa: E402
import pipeline  # noqa: E402
from deadline import AlignmentFailed, AlignmentTimeout, Gate, WorkerBusy, alignment_limit, anchor_limit  # noqa: E402

FAKE_CHILD = textwrap.dedent("""
    import json, subprocess, sys, time
    mode, pidfile, spec, result = sys.argv[1:5]
    if mode == "sleep":
        grandchild = subprocess.Popen(["sleep", "300"])
        open(pidfile, "w").write(f"{__import__('os').getpid()} {grandchild.pid}")
        time.sleep(300)
    elif mode == "crash":
        sys.exit(3)
    else:
        intervals = [] if mode == "empty" else [{"index": 0, "start": 1.0, "end": 2.0}]
        if mode == "full": intervals.append({"index": 1, "start": 2.0, "end": 3.0})
        json.dump({"intervals": intervals, "quality": None, "peakMemoryMB": 12.5}, open(result, "w"))
""")
# Writes an empty file at its last argument, like ffmpeg writing the wave.
FAKE_FFMPEG = "#!/bin/sh\nfor last; do :; done\n: > \"$last\"\n"
SLOW_FFMPEG = "#!/bin/sh\nsleep 300\n"

def alive(pid):
    try:
        # A zombie still answers kill(0) but is already dead; only a reaped process is gone.
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False

class Worker(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.folder = self.dir / "alignment"
        self.folder.mkdir()
        self.child_script = self.dir / "child.py"
        self.child_script.write_text(FAKE_CHILD)
        self.ffmpeg = self.make_executable("ffmpeg", FAKE_FFMPEG)
        self.pidfile = self.dir / "pids"
        # A one second limit keeps the timeout tests short.
        self.env = {"ALIGNMENT_TIMEOUT_BASE_SECONDS": "1", "ALIGNMENT_TIMEOUT_PER_AUDIO_SECOND": "0", "ALIGNMENT_TIMEOUT_MAX_SECONDS": "1"}

    def make_executable(self, name, body):
        path = self.dir / name
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return str(path)

    def run_align(self, mode, ffmpeg=None):
        return pipeline.align_section(
            audio=self.dir / "book.m4b", output=self.folder / "section-1" / "out.json", fragments=["One.", "Two."], language="eng",
            start=0, duration=600, media_folder=self.folder, env=self.env, ffmpeg=ffmpeg or self.ffmpeg,
            child=[sys.executable, str(self.child_script), mode, str(self.pidfile)])

    def leftovers(self):
        return sorted(str(path.relative_to(self.folder)) for path in self.folder.rglob("*") if path.is_file())

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

class Deadline(Worker):
    def test_timeout_kills_the_child_and_its_group_frees_the_gate_and_cleans_up(self):
        gate = Gate()
        started = time.monotonic()
        with self.assertRaises(AlignmentTimeout) as caught:
            with gate.hold():
                self.run_align("sleep")
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(str(caught.exception).split(".")[0], "Local alignment timed out after 1 seconds")
        child, grandchild = (int(value) for value in self.pidfile.read_text().split())
        self.assertFalse(alive(child), "the child process is gone")
        self.assertFalse(alive(grandchild), "the child's own subprocess is gone too")
        self.assertFalse(gate.busy)
        self.assertIsNone(gate.busy_seconds())
        self.assertRegex(gate.last_timeout, r"^\d{4}-\d\d-\d\dT")
        self.assertEqual(self.leftovers(), [])
        with gate.hold():  # a request right after is accepted, not "busy"
            result = self.run_align("ok")
        self.assertEqual(result["intervals"], [{"index": 0, "start": 1.0, "end": 2.0}])

    def test_the_limit_covers_audio_extraction_too(self):
        with self.assertRaises(AlignmentTimeout):
            self.run_align("ok", ffmpeg=self.make_executable("slow-ffmpeg", SLOW_FFMPEG))
        self.assertEqual(self.leftovers(), [])

    def test_success_writes_the_cache_file_and_removes_working_files(self):
        result = self.run_align("ok")
        self.assertEqual(result["peakMemoryMB"], 12.5)
        self.assertEqual(result["engine"], "aeneas-1.7.3")
        self.assertEqual(result["outcome"], "partial")
        self.assertEqual(set(result["stageTimings"]), {"audioExtraction", "alignment"})
        self.assertTrue(all(value >= 0 for value in result["stageTimings"].values()))
        self.assertEqual(json.loads((self.folder / "section-1" / "out.json").read_text()), result)
        self.assertEqual(self.leftovers(), ["section-1/out.json"])

    def test_anchor_reports_engine_outcome_and_timing(self):
        for match, outcome in [(None, "unsynced"), ({"index": 0, "score": 1}, "mapped")]:
            with self.subTest(outcome=outcome), mock.patch.object(pipeline, "_run_child", return_value={"match": match}):
                result = pipeline.locate_passage(audio=self.dir / "a.m4b", folder=self.folder, fragments=["x"], language="eng", start=0, duration=30, env=self.env)
                self.assertEqual(result["engine"], "aeneas-1.7.3")
                self.assertEqual(result["outcome"], outcome)
                self.assertGreaterEqual(result["stageTimings"]["speechRecovery"], 0)

    def test_align_distinguishes_fully_mapped_and_unsynced(self):
        self.assertEqual(self.run_align("full")["outcome"], "mapped")
        self.assertEqual(self.run_align("empty")["outcome"], "unsynced")

    def test_a_crashing_child_is_a_failure_not_a_timeout(self):
        with self.assertRaises(AlignmentFailed):
            self.run_align("crash")
        self.assertEqual(self.leftovers(), [])

    def test_locate_passage_has_its_own_deadline(self):
        # A killed child skips its own cleanup and leaves its sample on the drive.
        (self.folder / "anchor-sample.wav").write_bytes(b"x")
        started = time.monotonic()
        with self.assertRaises(AlignmentTimeout):
            pipeline.locate_passage(audio=self.dir / "a.m4b", folder=self.folder, fragments=["x"], language="eng", start=0, duration=30, env=self.env,
                                    child=[sys.executable, str(self.child_script), "sleep", str(self.pidfile)])
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(self.leftovers(), [], "no anchor sample or working file is left on the media drive")

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
        for call, request, target in [(self.align.align, self.align_request(), "align_section"), (self.align.anchor, self.anchor_request(), "locate_passage")]:
            with self.subTest(target=target):
                status, detail, _ = self.status_of(call, request, target, AlignmentTimeout(5))
                self.assertEqual(status, 504)
                self.assertIn("timed out", detail)

    def test_worker_failure_responses_include_metadata(self):
        for call, request, target in [(self.align.align, self.align_request(), "align_section"), (self.align.anchor, self.anchor_request(), "locate_passage")]:
            with self.subTest(target=target), mock.patch.object(self.align, target, side_effect=AlignmentTimeout(5)):
                with self.assertRaises(self.align.HTTPException) as caught:
                    call(request)
                detail = caught.exception.detail
                self.assertEqual(detail["engine"], "aeneas-1.7.3")
                self.assertEqual(detail["outcome"], "error")
                self.assertGreaterEqual(detail["stageTimings"]["failedRequest"], 0)

    def test_a_busy_worker_is_409_and_other_failures_are_422_with_a_log_line(self):
        with self.align.gate.hold():
            status, _, _ = self.status_of(self.align.align, self.align_request(), "align_section", AlignmentTimeout(5))
        self.assertEqual(status, 409)
        status, _, log = self.status_of(self.align.align, self.align_request(), "align_section", AlignmentFailed("espeak data missing"))
        self.assertEqual(status, 422)
        self.assertIn("espeak data missing", log, "the worker log says why, the response does not")

    def test_health_reports_a_stuck_job(self):
        self.assertEqual(set(self.align.health()) >= {"busy", "stuck", "busySeconds", "lastTimeout"}, True)
        self.assertTrue(self.align.health()["ctc"]["passageReady"])

    def test_unsupported_language_is_explicit_for_both_endpoints(self):
        for call, request in [(self.align.align, self.align_request()), (self.align.anchor, self.anchor_request())]:
            request.language = "jpn"
            result = call(request)
            self.assertEqual(result["engine"], "aeneas-1.7.3")
            self.assertEqual(result["outcome"], "language_not_supported")
            self.assertGreaterEqual(result["stageTimings"]["requestValidation"], 0)

    def test_ctc_is_explicit_and_legacy_requests_keep_aeneas(self):
        request = self.align_request()
        self.assertEqual(request.engine, "aeneas")
        with mock.patch.object(self.align, "align_section", return_value={"engine": "aeneas-1.7.3"}) as legacy:
            self.assertEqual(self.align.align(request)["engine"], "aeneas-1.7.3")
            legacy.assert_called_once()
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
        with mock.patch.object(self.align, "align_ctc_section", return_value=fake) as ctc, \
                mock.patch.object(self.align, "locate_passage") as whisper:
            self.assertEqual(self.align.anchor(request), fake)
            self.assertTrue(ctc.call_args.kwargs["locate"])
            self.assertEqual({key: ctc.call_args.kwargs[key] for key in ("recording_id", "recording_fingerprint", "track_id")},
                             {"recording_id": "recording", "recording_fingerprint": "audio-version", "track_id": "track"})
            whisper.assert_not_called()
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
