"""Worker deadline tests. Run with `python3 -m unittest discover -s tests/worker`; needs neither fastapi nor aeneas."""
import contextlib
import io
import json
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

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
        json.dump({"intervals": [{"index": 0, "start": 1.0, "end": 2.0}], "quality": None, "peakMemoryMB": 12.5}, open(result, "w"))
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
        self.assertEqual(anchor_limit(60, {"ALIGNMENT_TIMEOUT_BASE_SECONDS": "1400"}), 170)

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
        self.assertEqual(json.loads((self.folder / "section-1" / "out.json").read_text()), result)
        self.assertEqual(self.leftovers(), ["section-1/out.json"])

    def test_a_crashing_child_is_a_failure_not_a_timeout(self):
        with self.assertRaises(AlignmentFailed):
            self.run_align("crash")
        self.assertEqual(self.leftovers(), [])

    def test_locate_passage_has_its_own_deadline(self):
        started = time.monotonic()
        with self.assertRaises(AlignmentTimeout):
            pipeline.locate_passage(audio=self.dir / "a.m4b", folder=self.folder, fragments=["x"], language="eng", start=0, duration=30, env=self.env,
                                    child=[sys.executable, str(self.child_script), "sleep", str(self.pidfile)])
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(self.leftovers(), [])

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

    def test_the_gate_is_released_when_the_job_raises(self):
        gate = Gate()
        with self.assertRaises(RuntimeError):
            with gate.hold():
                raise RuntimeError("boom")
        with gate.hold():
            pass

if __name__ == "__main__":
    unittest.main()
