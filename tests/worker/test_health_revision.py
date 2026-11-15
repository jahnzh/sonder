"""/health names the installed code revision (#411). Needs neither fastapi nor torch: both are stubbed."""
import importlib.util
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[2] / "worker"


def stub_modules():
    fastapi = types.ModuleType("fastapi")

    class FastAPI:
        def __init__(self, **_kwargs):
            pass

        def get(self, _path):
            return lambda fn: fn

        post = get

    class HTTPException(Exception):
        def __init__(self, status_code, detail=None):
            super().__init__(detail)
            self.status_code = status_code

    fastapi.FastAPI, fastapi.HTTPException = FastAPI, HTTPException
    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = type("BaseModel", (), {})
    pydantic.Field = lambda *args, **kwargs: None
    pipeline = types.ModuleType("ctc_pipeline")
    pipeline.align_ctc_batch_locate = pipeline.align_ctc_section = lambda **_kwargs: {}
    pipeline.shutdown_locate_pool = lambda: None
    decode = types.ModuleType("ctc_decode")
    decode.evict_decoded = lambda _folder: None
    gpu = types.ModuleType("ctc_gpu")
    gpu.GpuMonitor = object
    prefetch = types.ModuleType("ctc_prefetch")
    prefetch.prefetch = prefetch.shutdown = lambda *args: None
    return {"fastapi": fastapi, "pydantic": pydantic, "ctc_pipeline": pipeline, "ctc_decode": decode,
            "ctc_gpu": gpu, "ctc_prefetch": prefetch}


def load_worker(folder):
    """Import a copy of worker/align.py from folder, as the service does from its release directory."""
    shutil.copy(WORKER / "align.py", folder / "align.py")
    for name in ("deadline.py", "ctc_acoustic.py"):
        shutil.copy(WORKER / name, folder / name)
    saved = {name: sys.modules.get(name) for name in [*stub_modules(), "deadline", "ctc_acoustic", "align_under_test"]}
    sys.modules.update(stub_modules())
    sys.path.insert(0, str(folder))
    try:
        for name in ("deadline", "ctc_acoustic"):
            sys.modules.pop(name, None)
        spec = importlib.util.spec_from_file_location("align_under_test", folder / "align.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(folder))
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


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
