"""The worker's code revision (#357): read from `REVISION` beside its code, unknown (None) when the file is missing,
unreadable or empty. Needs neither fastapi nor torch."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from revision import REVISION_FILE, read_revision  # noqa: E402


class Revision(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_file_sits_beside_the_worker_code(self):
        self.assertEqual(REVISION_FILE.parent, (Path(__file__).resolve().parents[2] / "worker"))
        self.assertEqual(REVISION_FILE.name, "REVISION")

    def test_the_commit_written_by_the_copy_is_reported(self):
        path = self.dir / "REVISION"
        path.write_text("c901429f0e2d3c4b5a69788796a5b4c3d2e1f0a9\n")
        self.assertEqual(read_revision(path), "c901429f0e2d3c4b5a69788796a5b4c3d2e1f0a9")

    def test_only_the_first_line_and_safe_characters_are_kept_and_the_length_is_capped(self):
        path = self.dir / "REVISION"
        path.write_text("  v1.2-3+g4 <script>\nsecond line\n")
        self.assertEqual(read_revision(path), "v1.2-3+g4script")
        path.write_text("a" * 200)
        self.assertEqual(read_revision(path), "a" * 64)

    def test_missing_empty_unreadable_or_a_directory_is_unknown(self):
        self.assertIsNone(read_revision(self.dir / "missing"))
        empty = self.dir / "empty"
        empty.write_text(" \n")
        self.assertIsNone(read_revision(empty))
        self.assertIsNone(read_revision(self.dir))
        binary = self.dir / "binary"
        binary.write_bytes(b"\xff\xfe\x00")
        self.assertIsNone(read_revision(binary))
        if os.geteuid() != 0:
            locked = self.dir / "locked"
            locked.write_text("abc")
            locked.chmod(0)
            self.assertIsNone(read_revision(locked))


def _align():
    try:
        sys.modules.pop("align", None)
        import align
        return align
    except ImportError:  # pragma: no cover - the server's test Python may lack the worker's packages
        return None


class HealthReportsTheRevision(unittest.TestCase):
    def test_health_has_the_revision_field(self):
        tmp = tempfile.TemporaryDirectory()
        previous = os.environ.get("MEDIA_ROOT")
        os.environ["MEDIA_ROOT"] = tmp.name
        try:
            align = _align()
            if align is None:
                self.skipTest("the worker's packages (fastapi) are not installed")
            self.assertIn("revision", align.health())
            align.REVISION = "abc123"
            self.assertEqual(align.health()["revision"], "abc123")
        finally:
            sys.modules.pop("align", None)
            if previous is None:
                os.environ.pop("MEDIA_ROOT", None)
            else:
                os.environ["MEDIA_ROOT"] = previous
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
