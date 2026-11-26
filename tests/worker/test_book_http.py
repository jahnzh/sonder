"""POST /book-jobs over a real HTTP connection (#402 review): the token is checked before the body is read,
and a body over the size limit is refused before it is buffered.

Runs the worker app in uvicorn on a loopback port and talks to it through a raw socket, so the test decides
how much of a body is ever sent. Needs fastapi and uvicorn (the worker's environment); no model, no numpy.
"""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
try:
    import fastapi  # noqa: F401
    import uvicorn
except ImportError:  # pragma: no cover - the server's test Python may have neither
    uvicorn = None

TOKEN = "secret-402"


def exchange(port, head, parts=(), timeout=5.0):
    """Send the request head and then `parts`; return (status, body bytes) of the response, or raise on timeout."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(head)
        try:
            for part in parts:
                sock.sendall(part)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the server answered and closed while the rest of the body was still on its way
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
        head_bytes, _, rest = data.partition(b"\r\n\r\n")
        headers = dict(line.split(b": ", 1) for line in head_bytes.split(b"\r\n")[1:] if b": " in line)
        length = int(headers.get(b"content-length", b"0"))
        while len(rest) < length:
            chunk = sock.recv(65536)
            if not chunk:
                break
            rest += chunk
    return int(head_bytes.split(b" ", 2)[1]), rest


def post_head(length=None, auth=True, chunked=False):
    lines = [b"POST /book-jobs HTTP/1.1", b"Host: 127.0.0.1", b"Content-Type: application/json"]
    if auth:
        lines.append(f"Authorization: Bearer {TOKEN}".encode())
    if chunked:
        lines.append(b"Transfer-Encoding: chunked")
    elif length is not None:
        lines.append(f"Content-Length: {length}".encode())
    return b"\r\n".join(lines) + b"\r\n\r\n"


def chunk(data):
    return f"{len(data):x}\r\n".encode() + data + b"\r\n"


@unittest.skipUnless(uvicorn is not None, "fastapi and uvicorn are needed")
class BookRequestOverHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.media = Path(cls.tmp.name)
        (cls.media / "staged").mkdir()
        (cls.media / "staged" / "t0.wav").write_bytes(b"RIFF")
        cls.env = mock.patch.dict(os.environ, {"MEDIA_ROOT": str(cls.media), "ALIGNMENT_WORKER_TOKEN": TOKEN})
        cls.env.start()
        sys.modules.pop("align", None)
        import align
        cls.align = align
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        cls.port = sock.getsockname()[1]
        cls.server = uvicorn.Server(uvicorn.Config(align.app, log_level="error", lifespan="on"))
        cls.thread = threading.Thread(target=cls.server.run, kwargs={"sockets": [sock]}, daemon=True)
        cls.thread.start()
        deadline = time.monotonic() + 30
        while not cls.server.started:
            if time.monotonic() > deadline:
                raise AssertionError("uvicorn did not start")
            time.sleep(0.02)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(30)
        sys.modules.pop("align", None)
        cls.env.stop()
        cls.tmp.cleanup()

    def setUp(self):
        # getattr: the same requests also run against a worker without the limit (it must fail them).
        self.limit = getattr(self.align, "BOOK_REQUEST_MAX_BYTES", 32 * 1024 * 1024)

    def tearDown(self):
        self.align.BOOK_REQUEST_MAX_BYTES = self.limit

    def body(self, audio=None):
        return json.dumps({"jobId": "http-402", "recordingId": "r1", "language": "eng",
                           "sentences": [{"id": "p0", "text": "Hello there."}],
                           "tracks": [{"id": "t0", "audio": audio or str(self.media / "staged" / "t0.wav"),
                                       "duration": 1.0}]}).encode()

    def test_an_unauthenticated_request_is_refused_before_its_body_is_read(self):
        # Two gigabytes announced, 64 KiB sent: a server that reads the body first never answers.
        started = time.monotonic()
        status, _ = exchange(self.port, post_head(2_000_000_000, auth=False), [b"x" * 65536])
        self.assertEqual(status, 401)
        self.assertLess(time.monotonic() - started, 3.0)

    def test_a_wrong_token_is_refused_before_the_body_is_read(self):
        head = post_head(2_000_000_000, auth=False).replace(b"\r\n\r\n", b"\r\nAuthorization: Bearer wrong\r\n\r\n", 1)
        status, _ = exchange(self.port, head, [b"x" * 65536])
        self.assertEqual(status, 401)

    def test_a_declared_body_over_the_limit_is_refused_unread(self):
        status, body = exchange(self.port, post_head(self.limit + 1), [b"x" * 65536])
        self.assertEqual(status, 413)
        self.assertIn(str(self.limit), json.loads(body)["detail"])

    def test_a_chunked_body_is_cut_off_at_the_limit(self):
        self.align.BOOK_REQUEST_MAX_BYTES = 100_000
        parts = [chunk(b" " * 16384) for _ in range(12)] + [b"0\r\n\r\n"]  # 196 KiB, no Content-Length
        status, _ = exchange(self.port, post_head(chunked=True), parts)
        self.assertEqual(status, 413)

    def test_the_limit_holds_a_real_book_request(self):
        # The largest request measured (7.8 MB) fits with room to spare.
        self.assertGreaterEqual(self.limit, 4 * 7_829_653)
        self.assertEqual(self.align.BOOK_REQUEST_MAX_BYTES, self.limit)

    def test_an_authenticated_body_under_the_limit_is_parsed_and_validated(self):
        outside = self.body(audio="/etc/passwd")
        status, body = exchange(self.port, post_head(len(outside)), [outside])
        self.assertEqual(status, 400, body)  # parsed: the track path was checked
        invalid = b'{"jobId": "../x"}'
        status, body = exchange(self.port, post_head(len(invalid)), [invalid])
        self.assertEqual(status, 422, body)
        self.assertEqual(json.loads(body)["detail"][0]["loc"][0], "body")
        broken = b"{not json"
        status, _ = exchange(self.port, post_head(len(broken)), [broken])
        self.assertEqual(status, 422)

    def test_section_titles_are_optional_and_validated(self):
        # #403: `sections` carries the titles of the result's unsynced passages and flags.
        request = json.loads(self.body(audio="/etc/passwd"))
        request["sections"] = [{"index": 0, "title": "Chapter One"}]
        data = json.dumps(request).encode()
        status, body = exchange(self.port, post_head(len(data)), [data])
        self.assertEqual(status, 400, body)  # parsed, then the track path was checked
        request["sections"] = [{"index": -1, "title": "x"}]
        data = json.dumps(request).encode()
        status, body = exchange(self.port, post_head(len(data)), [data])
        self.assertEqual(status, 422, body)
        self.assertEqual(json.loads(body)["detail"][0]["loc"][:2], ["body", "sections"])

    GET_HEALTH = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    # /health's fields as on origin/main: they describe window requests only (#402 round 2, decision A).
    WINDOW_FIELDS = ("ready", "engine", "busy", "stuck", "busySeconds", "lastTimeout", "slots", "activeRequests",
                     "mediaRoot", "ctc")

    def health(self):
        return json.loads(exchange(self.port, self.GET_HEALTH)[1])

    def test_health_window_fields_are_the_same_with_and_without_a_book_batch(self):
        idle = self.health()
        self.assertEqual((idle["busy"], idle["activeRequests"], idle["bookJobs"]["slotsHeld"]), (False, 0, 0))
        with mock.patch.multiple("deadline", WINDOW_GRACE_S=0, WINDOW_RETRY_S=0), \
                self.align.gate.hold_background():  # what a book job holds during one encode batch
            during = self.health()
        self.assertEqual({k: during[k] for k in self.WINDOW_FIELDS}, {k: idle[k] for k in self.WINDOW_FIELDS})
        self.assertEqual(during["bookJobs"]["slotsHeld"], 1, "book work is reported under bookJobs only")
        self.assertIsNotNone(during["bookJobs"]["batchSeconds"])
        self.assertEqual(during["bookJobs"]["stuck"], [])
        self.assertIs(self.align.book_jobs.stages.admission, self.align.gate, "book encodes use the window gate")

    def test_the_servers_order_health_then_a_window_request_is_served_within_one_batch(self):
        # The server reads /health first and dispatches only to a worker that is not busy
        # (server/alignment-pool.ts). A book encode runs batch after batch; the window request is served
        # after at most the batch it found on the device.
        batch = 0.5
        audio = self.media / "staged" / "window.wav"
        audio.write_bytes(b"RIFF")
        served = []

        def fake_section(**kwargs):
            served.append((time.monotonic(), self.align.gate.background_active))
            return {"engine": self.align.CTC_ENGINE, "outcome": "mapped", "match": None, "stageTimings": {}}

        stop = threading.Event()
        batches = []

        def book():
            import deadline
            while not stop.is_set():
                try:
                    with self.align.gate.hold_background(stop.is_set):
                        start = time.monotonic()
                        time.sleep(batch)
                        batches.append((start, time.monotonic()))
                except deadline.GateWaitStopped:
                    return

        body = json.dumps({"token": TOKEN, "audio": str(audio), "output": str(self.media / "alignment" / "w.json"),
                           "fragments": ["Hello there."], "duration": 10.0}).encode()
        head = (b"POST /anchor HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
                b"Connection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n")
        thread = threading.Thread(target=book, daemon=True)
        with mock.patch.object(self.align, "align_ctc_section", fake_section):
            thread.start()
            try:
                while not batches:
                    time.sleep(0.01)
                for _ in range(3):
                    health = self.health()
                    self.assertFalse(health["busy"], "a book batch never makes the worker look busy")
                    self.assertEqual(health["activeRequests"], 0)
                    self.assertGreaterEqual(health["bookJobs"]["slotsHeld"] + len(batches), 1)
                    sent = time.monotonic()
                    status, answer = exchange(self.port, head, [body], timeout=10)
                    self.assertEqual(status, 200, answer)
                    self.assertLess(served[-1][0] - sent, batch + 0.5, "served within one batch")
                    self.assertEqual(served[-1][1], 0, "no batch ran beside the window request")
                    time.sleep(0.1)
            finally:
                stop.set()
                thread.join(5)
        self.assertGreater(len(batches), 1, "the book kept encoding between the window requests")

    def test_a_request_that_does_not_fit_the_disk_budget_is_refused_before_anything_is_written(self):
        budget = self.align.book_jobs.registry.budget
        budget.claim("someone-else", budget.total - 1000)
        try:
            raw = self.body().replace(b'"http-402"', b'"http-402-full"')
            status, body = exchange(self.port, post_head(len(raw)), [raw])
        finally:
            budget.release("someone-else")
        self.assertEqual(status, 507, body)
        self.assertIn("full", json.loads(body)["detail"])
        self.assertFalse((self.media / "alignment" / "book-jobs" / "http-402-full").exists())
        self.assertEqual(budget.reserved("http-402-full"), 0)

    def test_health_answers_while_a_job_start_is_blocked_on_the_filesystem(self):
        # Round-4 review: /health took the book jobs' lock, which a start holds across its folder reads.
        # The server's probe gives up after 5 s and drops the host; /health must answer at once.
        import book_job
        real = book_job.folder_bytes
        entered, release = threading.Event(), threading.Event()

        def slow(folder):
            if Path(folder).name == "http-402-slow" and not release.is_set():
                entered.set()
                release.wait(10)  # a stalled stat of the job's folder
            return real(folder)

        raw = self.body().replace(b'"http-402"', b'"http-402-slow"')
        started = []
        poster = threading.Thread(target=lambda: started.append(exchange(self.port, post_head(len(raw)), [raw],
                                                                           timeout=15)))
        with mock.patch.object(book_job, "folder_bytes", slow), \
                mock.patch.object(self.align.book_jobs, "_launch", lambda job: None):  # no stages run
            poster.start()
            try:
                self.assertTrue(entered.wait(5), "the start reached its folder read")
                sent = time.monotonic()
                health = json.loads(exchange(self.port, self.GET_HEALTH, timeout=3)[1])
                self.assertLess(time.monotonic() - sent, 1.0, "/health does not wait for the start")
                self.assertEqual((health["busy"], health["activeRequests"]), (False, 0))
            finally:
                release.set()
                poster.join(15)
        self.assertEqual(started[0][0], 202, started[0][1])
        status, body = exchange(self.port, b"DELETE /book-jobs/http-402-slow HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                                b"Authorization: Bearer " + TOKEN.encode() + b"\r\nConnection: close\r\n\r\n")
        self.assertEqual(status, 200, body)


def book_request(job_id, audio):
    return {"jobId": job_id, "recordingId": "r1", "audioFingerprint": None, "language": "eng",
            "sentences": [{"id": "p0", "section": 0, "text": "Hello there."}],
            "tracks": [{"id": "t0", "audio": str(audio), "duration": 1.0}]}


def get(path):
    return (f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\n"
            "Connection: close\r\n\r\n").encode()


@unittest.skipUnless(uvicorn is not None, "fastapi and uvicorn are needed")
class StartupWithRetainedJobs(unittest.TestCase):
    """Round-4 review (BLOCKING): the retained folders were read before the worker served anything. A worker
    with a retained job whose folder read blocks serves /health and the window endpoints at once; book
    requests get 503 until the resume has finished, and the retained job is intact afterwards."""

    def test_a_retained_folder_whose_read_blocks_does_not_delay_the_worker(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        media = Path(tmp.name)
        (media / "staged").mkdir()
        audio = media / "staged" / "t0.wav"
        audio.write_bytes(b"RIFF")
        import book_job
        request = book_request("kept-1", audio)
        folder = media / "alignment" / "book-jobs" / "kept-1"
        folder.mkdir(parents=True)
        (folder / "request.json").write_text(json.dumps(request))
        (folder / "state.json").write_text(json.dumps({
            "jobId": "kept-1", "engine": book_job.BOOK_ENGINE, "digest": book_job.request_digest(request),
            "state": "done", "recordingId": "r1", "createdAt": 1.0, "updatedAt": 1.0, "progress": {},
            "stageTimings": {}, "error": None, "resumed": 0, "outcome": "mapped"}))
        result = {"jobId": "kept-1", "engine": book_job.BOOK_ENGINE, "outcome": "mapped", "intervals": []}
        (folder / "result.json").write_text(json.dumps(result))
        kept = {name: (folder / name).read_bytes() for name in ("request.json", "result.json")}

        real = book_job.folder_bytes
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def slow(path):
            if Path(path).name == "kept-1" and not release.is_set():
                entered.set()
                release.wait(15)  # a stalled read of the retained folder (under the jobs' lock)
            return real(path)

        # The retained job is Base's: a worker of the other book model would start it over (#921).
        env = mock.patch.dict(os.environ, {"MEDIA_ROOT": str(media), "ALIGNMENT_WORKER_TOKEN": TOKEN,
                                           "ALIGNMENT_BOOK_MODEL": "wav2vec2-base"})
        env.start()
        self.addCleanup(env.stop)
        patch = mock.patch.object(book_job, "folder_bytes", slow)
        patch.start()
        self.addCleanup(patch.stop)
        sys.modules.pop("align", None)
        self.addCleanup(sys.modules.pop, "align", None)
        import align
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(align.app, log_level="error", lifespan="on"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)

        def stop():
            release.set()
            server.should_exit = True
            thread.join(30)
        self.addCleanup(stop)
        began = time.monotonic()
        thread.start()
        while not server.started and time.monotonic() - began < 5:
            time.sleep(0.02)
        self.assertTrue(server.started, "the worker serves before its retained folders are read")
        self.assertTrue(entered.wait(5), "the resume is blocked on the retained folder")

        sent = time.monotonic()
        health = json.loads(exchange(port, b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                                     timeout=3)[1])
        self.assertLess(time.monotonic() - sent, 1.0, "the first /health answers at once")
        self.assertEqual((health["busy"], health["activeRequests"]), (False, 0))
        self.assertTrue(health["bookJobs"]["resuming"])

        window = media / "staged" / "window.wav"
        window.write_bytes(b"RIFF")
        body = json.dumps({"token": TOKEN, "audio": str(window), "output": str(media / "alignment" / "w.json"),
                           "fragments": ["Hello there."], "duration": 10.0}).encode()
        head = (b"POST /anchor HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
                b"Connection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n")
        mapped = {"engine": align.CTC_ENGINE, "outcome": "mapped", "match": None, "stageTimings": {}}
        with mock.patch.object(align, "align_ctc_section", lambda **_: dict(mapped)):
            sent = time.monotonic()
            status, answer = exchange(port, head, [body], timeout=3)
        self.assertEqual(status, 200, answer)
        self.assertLess(time.monotonic() - sent, 1.0, "a window request is served during the resume")

        status, answer = exchange(port, get("/book-jobs/kept-1"), timeout=3)
        self.assertEqual(status, 503, answer)
        self.assertIn("retained book jobs", json.loads(answer)["detail"])
        raw = json.dumps(request).encode()
        status, answer = exchange(port, post_head(len(raw)), [raw], timeout=3)
        self.assertEqual(status, 503, answer)
        status, _ = exchange(port, b"DELETE /book-jobs/kept-1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: "
                             b"Bearer " + TOKEN.encode() + b"\r\nConnection: close\r\n\r\n", timeout=3)
        self.assertEqual(status, 503)
        self.assertEqual({name: (folder / name).read_bytes() for name in kept}, kept, "the retained job is untouched")

        release.set()
        waited = time.monotonic()
        while align.book_jobs.resuming and time.monotonic() - waited < 10:
            time.sleep(0.02)
        self.assertFalse(align.book_jobs.resuming)
        status, answer = exchange(port, get("/book-jobs/kept-1"), timeout=3)
        self.assertEqual(status, 200, answer)
        self.assertEqual(json.loads(answer)["state"], "done")
        status, answer = exchange(port, get("/book-jobs/kept-1/result"), timeout=5)
        self.assertEqual((status, json.loads(answer)), (200, result))


if __name__ == "__main__":
    unittest.main()
