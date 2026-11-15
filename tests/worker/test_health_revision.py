"""/health names the installed code revision (#411). Imports the real worker, so it needs fastapi (not torch)."""
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[2] / "worker"

try:
    import fastapi  # noqa: F401
    import pydantic  # noqa: F401
except ImportError:
    fastapi = None


def load_worker(folder):
    """Import a copy of the worker's code from folder, as the service does from its release directory."""
    for source in WORKER.glob("*.py"):
        shutil.copy(source, folder / source.name)
    media = folder / "media"
    (media / "alignment").mkdir(parents=True, exist_ok=True)
    names = [source.stem for source in WORKER.glob("*.py")] + ["align_under_test"]
    saved = {name: sys.modules.pop(name, None) for name in names}
    environment = {name: os.environ.get(name) for name in ("MEDIA_ROOT", "ALIGNMENT_WORKER_TOKEN", "MEDIA_VOLUME_ID")}
    os.environ["MEDIA_ROOT"], os.environ["ALIGNMENT_WORKER_TOKEN"] = str(media), "secret"
    os.environ.pop("MEDIA_VOLUME_ID", None)
    sys.path.insert(0, str(folder))
    try:
        spec = importlib.util.spec_from_file_location("align_under_test", folder / "align.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(folder))
        for name in names:
            sys.modules.pop(name, None)
            if saved[name] is not None:
                sys.modules[name] = saved[name]
        for name, value in environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@unittest.skipIf(fastapi is None, "fastapi is not installed here; the worker image has it")
class HealthRevision(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="sonder-health-revision-"))
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)

    def test_health_names_the_revision_written_beside_the_code(self):
        (self.folder / "REVISION").write_text("58e6dba1ff82586456beeb5416edf8fa8696ee1e\n")
        health = load_worker(self.folder).health()
        self.assertEqual(health["revision"], "58e6dba1ff82586456beeb5416edf8fa8696ee1e")

    def test_a_missing_revision_file_reports_null_unknown(self):
        health = load_worker(self.folder).health()
        self.assertIn("revision", health)
        self.assertIsNone(health["revision"])

    def test_the_revision_is_read_at_startup_not_per_request(self):
        (self.folder / "REVISION").write_text("first\n")
        worker = load_worker(self.folder)
        (self.folder / "REVISION").write_text("second\n")
        self.assertEqual(worker.health()["revision"], "first")

    def test_every_field_the_server_reads_is_still_there(self):
        health = load_worker(self.folder).health()
        for field in ("ready", "engine", "busy", "stuck", "busySeconds", "lastTimeout", "slots", "activeRequests",
                      "mediaRoot"):
            self.assertIn(field, health)
        for field in ("engine", "ready", "device", "precision", "anchorReady", "passageReady", "anchorBatch"):
            self.assertIn(field, health["ctc"])


if __name__ == "__main__":
    unittest.main()
