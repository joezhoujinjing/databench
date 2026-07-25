from __future__ import annotations

import hashlib
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path


CHUNK_BYTES = 64 * 1024
MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024


class ArtifactTransferError(RuntimeError):
    """A safe artifact-transfer failure that never includes a signed URL."""


class ArtifactTransferStopped(ArtifactTransferError):
    """The caller requested a cooperative transfer stop."""


@dataclass(frozen=True)
class ArtifactDescriptor:
    size: int
    digest: str


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def download_artifact(
    url: str,
    destination: Path,
    *,
    expected_size: int,
    expected_digest: str,
    expected_media_type: str,
    timeout_seconds: float,
    stop_requested: Callable[[], bool] = lambda: False,
) -> ArtifactDescriptor:
    _validate_url(url)
    _validate_size(expected_size)
    _validate_digest(expected_digest)
    digest = hashlib.sha256()
    size = 0
    request = urllib.request.Request(url, method="GET")
    try:
        _raise_if_stopped(stop_requested)
        with _OPENER.open(request, timeout=timeout_seconds) as response:
            if not 200 <= response.status < 300:
                raise ArtifactTransferError("artifact download returned a non-success status")
            media_type = response.headers.get_content_type()
            if media_type != expected_media_type:
                raise ArtifactTransferError("artifact download media type does not match its descriptor")
            with destination.open("xb") as output:
                os.chmod(destination, 0o600)
                while True:
                    _raise_if_stopped(stop_requested)
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    if len(chunk) > expected_size - size:
                        raise ArtifactTransferError("artifact download exceeds its declared size")
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                _raise_if_stopped(stop_requested)
                output.flush()
                os.fsync(output.fileno())
    except ArtifactTransferError:
        raise
    except (OSError, urllib.error.URLError) as exc:
        raise ArtifactTransferError("artifact download failed") from exc

    actual_digest = digest.hexdigest()
    if size != expected_size:
        raise ArtifactTransferError("artifact download size does not match its descriptor")
    if actual_digest != expected_digest:
        raise ArtifactTransferError("artifact download digest does not match its descriptor")
    return ArtifactDescriptor(size=size, digest=actual_digest)


def upload_artifact(
    url: str,
    source: Path,
    *,
    media_type: str,
    max_size: int,
    timeout_seconds: float,
    stop_requested: Callable[[], bool] = lambda: False,
) -> ArtifactDescriptor:
    _validate_url(url)
    _validate_size(max_size)
    try:
        size = source.stat().st_size
    except OSError as exc:
        raise ArtifactTransferError("artifact output cannot be inspected") from exc
    if size > max_size:
        raise ArtifactTransferError("artifact output exceeds its declared limit")

    digest = hashlib.sha256()
    try:
        with source.open("rb") as input_stream:
            for chunk in _read_chunks(input_stream, stop_requested):
                digest.update(chunk)
        with source.open("rb") as input_stream:
            request = urllib.request.Request(
                url,
                data=_read_chunks(input_stream, stop_requested),
                method="PUT",
                headers={
                    "Content-Length": str(size),
                    "Content-Type": media_type,
                },
            )
            with _OPENER.open(request, timeout=timeout_seconds) as response:
                if not 200 <= response.status < 300:
                    raise ArtifactTransferError("artifact upload returned a non-success status")
        _raise_if_stopped(stop_requested)
    except ArtifactTransferError:
        raise
    except (OSError, urllib.error.URLError) as exc:
        raise ArtifactTransferError("artifact upload failed") from exc
    return ArtifactDescriptor(size=size, digest=digest.hexdigest())


def _validate_url(url: str) -> None:
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as exc:
        raise ArtifactTransferError("artifact URL is invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ArtifactTransferError("artifact URL must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise ArtifactTransferError("artifact URL contains forbidden components")


def _validate_size(value: int) -> None:
    if type(value) is not int or not 0 <= value <= MAX_ARTIFACT_BYTES:
        raise ArtifactTransferError("artifact size is outside the Worker limit")


def _validate_digest(value: str) -> None:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ArtifactTransferError("artifact digest is invalid")


def _read_chunks(stream, stop_requested: Callable[[], bool]) -> Iterator[bytes]:  # noqa: ANN001
    while True:
        _raise_if_stopped(stop_requested)
        chunk = stream.read(CHUNK_BYTES)
        if not chunk:
            return
        yield chunk


def _raise_if_stopped(stop_requested: Callable[[], bool]) -> None:
    if stop_requested():
        raise ArtifactTransferStopped("artifact transfer stopped")
