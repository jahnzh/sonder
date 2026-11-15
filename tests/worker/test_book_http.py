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


if __name__ == "__main__":
    unittest.main()
