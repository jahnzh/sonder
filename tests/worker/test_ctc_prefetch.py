"""Parallel section extraction ahead of use (#346): fake ffmpeg, no model, no GPU."""
import os
import stat
import sys
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import ctc_prefetch
from ctc_acoustic import CONTEXT, CORE


def fake_ffmpeg(directory, delay=0.0, fail=False):
    script = Path(directory) / "ffmpeg"
    script.write_text(
        "#!/bin/sh\n"
        + f"sleep {delay}\n"
        + ("echo broken >&2\nexit 3\n" if fail else 'for last; do :; done\nprintf "RIFFfake" > "$last"\n')
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script)


class Prefetch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.audio = self.dir / "track.mp3"
        self.audio.write_bytes(b"audio")
        self.media = self.dir / "alignment"
        self.media.mkdir()
        self.env = {"ALIGNMENT_EXTRACT_WORKERS": "4"}
        ctc_prefetch.shutdown()

    def tearDown(self):
        # An extraction still running would write into the folder being removed.
        ctc_prefetch.shutdown(wait=True)
        self.tmp.cleanup()

    def wait_for(self, start, duration):
        key, *_ = ctc_prefetch._key(self.audio, start, duration)
        entry = ctc_prefetch._ENTRIES[key]
        entry.future.result(timeout=10)

    def test_window_covers_whole_cores_with_context(self):
        wave_start, wave_end = ctc_prefetch.section_window(30.0, 50.0)
        self.assertEqual(wave_start, CORE - CONTEXT)
        self.assertEqual(wave_end, 4 * CORE + CONTEXT)
        self.assertEqual(ctc_prefetch.section_window(0.0, 1.0)[0], 0)

    def test_workers_default_by_device_and_override(self):
        self.assertEqual(ctc_prefetch.extract_workers({"ALIGNMENT_EXTRACT_WORKERS": "3"}), 3)
        self.assertEqual(ctc_prefetch.extract_workers({"ALIGNMENT_EXTRACT_WORKERS": "99"}), ctc_prefetch.extract_workers({}))
        self.assertEqual(ctc_prefetch.extract_workers({"ALIGNMENT_CTC_DEVICE": "cpu"}), 1)
        self.assertGreaterEqual(ctc_prefetch.extract_workers({"ALIGNMENT_CTC_DEVICE": "cuda"}), 1)

    def test_take_returns_prefetched_file(self):
        ffmpeg = fake_ffmpeg(self.dir)
        self.assertTrue(ctc_prefetch.prefetch(self.audio, 0, 30, self.media, ffmpeg, self.env))
        self.wait_for(0, 30)
        destination = self.dir / "section.ctc.wav"
        self.assertTrue(ctc_prefetch.take(self.audio, 0, 30, destination, time.monotonic() + 5))
        self.assertEqual(destination.read_bytes(), b"RIFFfake")
        self.assertEqual(list((self.media / "ctc-prefetch").glob("*.wav")), [])
        self.assertFalse(ctc_prefetch.take(self.audio, 0, 30, destination, time.monotonic() + 5), "consumed once")

    def test_duplicate_window_is_queued_once(self):
        ffmpeg = fake_ffmpeg(self.dir)
        self.assertTrue(ctc_prefetch.prefetch(self.audio, 0, 30, self.media, ffmpeg, self.env))
        self.assertFalse(ctc_prefetch.prefetch(self.audio, 0, 30, self.media, ffmpeg, self.env))

    def test_unknown_window_falls_back_to_inline(self):
        self.assertFalse(ctc_prefetch.take(self.audio, 100, 30, self.dir / "x.wav", time.monotonic() + 5))

    def test_failed_extraction_falls_back_and_leaves_nothing(self):
        ffmpeg = fake_ffmpeg(self.dir, fail=True)
        ctc_prefetch.prefetch(self.audio, 0, 30, self.media, ffmpeg, self.env)
        key, *_ = ctc_prefetch._key(self.audio, 0, 30)
        entry = ctc_prefetch._ENTRIES[key]
        with self.assertRaises(Exception):
            entry.future.result(timeout=10)
        self.assertFalse(ctc_prefetch.take(self.audio, 0, 30, self.dir / "x.wav", time.monotonic() + 5))
        self.assertEqual(list((self.media / "ctc-prefetch").iterdir()), [])

    def test_changed_audio_is_not_reused(self):
        ffmpeg = fake_ffmpeg(self.dir)
        ctc_prefetch.prefetch(self.audio, 0, 30, self.media, ffmpeg, self.env)
        self.wait_for(0, 30)
        self.audio.write_bytes(b"different audio")
        os.utime(self.audio, (time.time() + 5, time.time() + 5))
        self.assertFalse(ctc_prefetch.take(self.audio, 0, 30, self.dir / "x.wav", time.monotonic() + 5))

    def test_windows_extract_in_parallel(self):
        ffmpeg = fake_ffmpeg(self.dir, delay=0.5)
        started = time.monotonic()
        for index in range(4):
            ctc_prefetch.prefetch(self.audio, index * 100, 30, self.media, ffmpeg, self.env)
        for index in range(4):
            self.assertTrue(ctc_prefetch.take(self.audio, index * 100, 30, self.dir / f"s{index}.wav", time.monotonic() + 10))
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.5, f"four 0.5 s extractions took {elapsed:.2f} s; serial would be 2 s")

    def test_oldest_entries_are_evicted_and_their_files_removed(self):
        ffmpeg = fake_ffmpeg(self.dir)
        for index in range(ctc_prefetch.MAX_ENTRIES + 3):
            ctc_prefetch.prefetch(self.audio, index * 100, 30, self.media, ffmpeg, self.env)
        self.assertLessEqual(len(ctc_prefetch._ENTRIES), ctc_prefetch.MAX_ENTRIES)
        self.assertFalse(ctc_prefetch.take(self.audio, 0, 30, self.dir / "x.wav", time.monotonic() + 5), "oldest evicted")

    def test_slow_extraction_times_out_to_inline_and_cleans_up(self):
        ffmpeg = fake_ffmpeg(self.dir, delay=1.0)
        ctc_prefetch.prefetch(self.audio, 0, 30, self.media, ffmpeg, self.env)
        self.assertFalse(ctc_prefetch.take(self.audio, 0, 30, self.dir / "x.wav", time.monotonic() + 0.05))
        deadline = time.monotonic() + 10
        folder = self.media / "ctc-prefetch"
        while time.monotonic() < deadline and any(folder.iterdir()):
            time.sleep(0.1)
        self.assertEqual(list(folder.iterdir()), [], "late file is removed once abandoned")

    def test_shutdown_removes_unclaimed_files(self):
        ffmpeg = fake_ffmpeg(self.dir)
        ctc_prefetch.prefetch(self.audio, 0, 30, self.media, ffmpeg, self.env)
        self.wait_for(0, 30)
        ctc_prefetch.shutdown()
        self.assertEqual(list((self.media / "ctc-prefetch").glob("*.wav")), [])

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed")
    def test_real_ffmpeg_writes_a_decodable_wav(self):
        source = self.dir / "tone.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-y", str(source)], check=True)
        self.assertTrue(ctc_prefetch.prefetch(source, 0, 3, self.media, "ffmpeg", self.env))
        destination = self.dir / "section.ctc.wav"
        self.assertTrue(ctc_prefetch.take(source, 0, 3, destination, time.monotonic() + 20))
        import wave
        with wave.open(str(destination), "rb") as handle:
            self.assertEqual((handle.getnchannels(), handle.getframerate()), (1, 16000))
            self.assertGreater(handle.getnframes(), 16000)
        self.assertEqual(list((self.media / "ctc-prefetch").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
