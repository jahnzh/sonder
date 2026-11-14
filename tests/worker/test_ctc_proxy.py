import http.client
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from ctc_proxy import Proxy


class Backend(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.headers.get("Transfer-Encoding") == "chunked":
            chunks = []
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if not size:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            data = b"".join(chunks)
        else:
            data = self.rfile.read(int(self.headers["Content-Length"]))
        body = f"{self.server.server_port} {self.path} ".encode() + data
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ProxyTest(unittest.TestCase):
    def test_routes_and_streams_request_and_response(self):
        servers = [ThreadingHTTPServer(("127.0.0.1", 0), Backend) for _ in range(2)]
        Proxy.routes = {"w1": servers[0].server_port, "w2": servers[1].server_port}
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        servers.append(proxy)
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        try:
            body = b"x" * 200_000
            for path, expected_port, expected_path in [
                ("/w1/align?x=1", servers[0].server_port, "/align?x=1"),
                ("/w2/anchor-batch", servers[1].server_port, "/anchor-batch"),
                ("/align", servers[0].server_port, "/align"),
            ]:
                conn = http.client.HTTPConnection("127.0.0.1", proxy.server_port, timeout=5)
                conn.request("POST", path, body)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), f"{expected_port} {expected_path} ".encode() + body)
                conn.close()
            conn = http.client.HTTPConnection("127.0.0.1", proxy.server_port, timeout=5)
            conn.request("POST", "/w2/align", iter([b"abc", b"def"]), encode_chunked=True)
            response = conn.getresponse()
            self.assertEqual(response.read(), f"{servers[1].server_port} /align ".encode() + b"abcdef")
            conn.close()
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()


if __name__ == "__main__":
    unittest.main()
