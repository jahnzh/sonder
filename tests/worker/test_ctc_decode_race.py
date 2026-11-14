import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
import ctc_decode


class DecodedCacheConcurrency(unittest.TestCase):
    def tearDown(self):
        ctc_decode.clear_decoded_cache()

    def test_eviction_and_new_decoded_track_do_not_race(self):
        started = threading.Event()
        changed = threading.Event()

        class SlowTrack:
            @property
            def path(self):
                started.set()
                changed.wait(0.2)
                return "/tmp/decoded-original.wav"

        class AddedTrack:
            path = "/tmp/decoded-added.wav"

        ctc_decode.clear_decoded_cache()
        with ctc_decode._LOCK:
            ctc_decode._remember(("original",), SlowTrack())

        def remember():
            if started.wait(2):
                with ctc_decode._LOCK:
                    ctc_decode._remember(("added",), AddedTrack())
                changed.set()

        thread = threading.Thread(target=remember)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as folder:
                ctc_decode.evict_decoded(folder)
        finally:
            thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertTrue(changed.is_set())

class DigestCacheConcurrency(unittest.TestCase):
    def test_concurrent_digests_stay_bounded_and_correct(self):
        import hashlib
        from concurrent.futures import ThreadPoolExecutor
        from unittest import mock
        import ctc_cache

        with tempfile.TemporaryDirectory() as folder:
            files = []
            for index in range(96):
                path = Path(folder) / str(index)
                content = f"audio-{index}".encode()
                path.write_bytes(content)
                files.append((path, hashlib.sha256(content).hexdigest()))
            with ctc_cache._DIGEST_LOCK:
                ctc_cache._DIGESTS.clear()
            try:
                with mock.patch.object(ctc_cache, "_QUIET_NS", -1):
                    with ThreadPoolExecutor(max_workers=12) as pool:
                        actual = list(pool.map(lambda pair: ctc_cache.audio_digest(pair[0])[0], files * 3))
                self.assertEqual(actual, [digest for _, digest in files] * 3)
                with ctc_cache._DIGEST_LOCK:
                    self.assertLessEqual(len(ctc_cache._DIGESTS), ctc_cache._DIGEST_LIMIT)
            finally:
                with ctc_cache._DIGEST_LOCK:
                    ctc_cache._DIGESTS.clear()
