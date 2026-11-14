"""Stream requests to local CTC processes behind one externally forwarded port."""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade"}


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    routes = {"w1": 3013, "w2": 3014}
    upstream_timeout = 1900

    def log_message(self, *_args):
        pass  # Worker requests may carry private book text.

    def forward(self):
        prefix, separator, rest = self.path.lstrip("/").partition("/")
        port = self.routes.get(prefix, self.routes["w1"])
        path = "/" + rest if prefix in self.routes and separator else self.path
        if prefix in self.routes and not separator:
            path = "/"
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=self.upstream_timeout)
        sent_headers = False
        try:
            connection.putrequest(self.command, path, skip_host=True, skip_accept_encoding=True)
            for key, value in self.headers.items():
                if key.lower() not in HOP_HEADERS and key.lower() != "host":
                    connection.putheader(key, value)
            connection.putheader("Host", f"127.0.0.1:{port}")
            chunked = self.headers.get("Transfer-Encoding", "").lower() == "chunked"
            if chunked:
                connection.putheader("Transfer-Encoding", "chunked")
            connection.endheaders()
            if chunked:
                while True:
                    header = self.rfile.readline(65537)
                    if not header or len(header) > 65536:
                        raise ValueError("invalid chunk header")
                    size = int(header.split(b";", 1)[0], 16)
                    connection.send(header)
                    if size == 0:
                        while True:
                            trailer = self.rfile.readline(65537)
                            if not trailer or len(trailer) > 65536:
                                raise ValueError("invalid chunk trailer")
                            connection.send(trailer)
                            if trailer == b"\r\n":
                                break
                        break
                    remaining = size + 2
                    while remaining:
                        data = self.rfile.read(min(remaining, 65536))
                        if not data:
                            raise ConnectionError("incomplete request")
                        connection.send(data)
                        remaining -= len(data)
            else:
                remaining = int(self.headers.get("Content-Length", "0"))
                while remaining:
                    data = self.rfile.read(min(remaining, 65536))
                    if not data:
                        raise ConnectionError("incomplete request")
                    connection.send(data)
                    remaining -= len(data)
            response = connection.getresponse()
            self.send_response(response.status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in HOP_HEADERS:
                    self.send_header(key, value)
            # http.client decodes chunked responses; close the connection to delimit one
            # without a length after forwarding the decoded body.
            if response.getheader("Content-Length") is None:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            sent_headers = True
            while True:
                data = response.read1(65536)
                if not data:
                    break
                self.wfile.write(data)
        except (OSError, ValueError, http.client.HTTPException):
            self.close_connection = True
            if not sent_headers:
                try:
                    self.send_error(502, "CTC worker unavailable")
                except OSError:
                    pass
        finally:
            connection.close()

    do_GET = forward
    do_POST = forward


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3012)
    parser.add_argument("--worker-one", type=int, default=3013)
    parser.add_argument("--worker-two", type=int, default=3014)
    args = parser.parse_args()
    Proxy.routes = {"w1": args.worker_one, "w2": args.worker_two}
    ThreadingHTTPServer((args.host, args.port), Proxy).serve_forever()


if __name__ == "__main__":
    main()
