from __future__ import annotations

import threading
from contextlib import AbstractContextManager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ArtifactServer(AbstractContextManager["ArtifactServer"]):
    def __init__(
        self,
        input_bytes: bytes,
        *,
        input_media_type: str = "application/x-ndjson",
    ) -> None:
        self.input_bytes = input_bytes
        self.input_media_type = input_media_type
        self.output_bytes: bytes | None = None
        self.output_content_type: str | None = None
        self.output_content_length: str | None = None
        self.get_count = 0
        self.put_count = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                owner.get_count += 1
                self.send_response(200)
                self.send_header("Content-Type", owner.input_media_type)
                self.send_header("Content-Length", str(len(owner.input_bytes)))
                self.end_headers()
                self.wfile.write(owner.input_bytes)

            def do_PUT(self) -> None:  # noqa: N802
                owner.put_count += 1
                owner.output_content_type = self.headers.get("Content-Type")
                owner.output_content_length = self.headers.get("Content-Length")
                if owner.output_content_length is None:
                    self.send_response(411)
                    self.end_headers()
                    return
                owner.output_bytes = self.rfile.read(int(owner.output_content_length))
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def input_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}/input?signature=input-secret"

    @property
    def output_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}/output?signature=output-secret"

    def __enter__(self) -> "ArtifactServer":
        self._thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
