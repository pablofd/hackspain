"""Servidor estático de desarrollo sin caché.

python3 serve.py  ->  http://127.0.0.1:4321
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 4321


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"maio en http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
