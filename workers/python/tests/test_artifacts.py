from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from databench_worker.runtime.artifacts import (
    ArtifactTransferError,
    ArtifactTransferStopped,
    download_artifact,
    upload_artifact,
)

from http_artifact_server import ArtifactServer


MEDIA_TYPE = "application/x-ndjson"


def test_download_and_upload_enforce_descriptors(tmp_path: Path) -> None:
    data = b'{"value":1}\n'
    digest = hashlib.sha256(data).hexdigest()
    with ArtifactServer(data) as server:
        downloaded = tmp_path / "downloaded.jsonl"
        descriptor = download_artifact(
            server.input_url,
            downloaded,
            expected_size=len(data),
            expected_digest=digest,
            expected_media_type=MEDIA_TYPE,
            timeout_seconds=2,
        )
        assert descriptor.size == len(data)
        assert descriptor.digest == digest
        assert downloaded.read_bytes() == data

        uploaded = upload_artifact(
            server.output_url,
            downloaded,
            media_type=MEDIA_TYPE,
            max_size=len(data),
            timeout_seconds=2,
        )
        assert uploaded == descriptor
        assert server.output_bytes == data
        assert server.output_content_type == MEDIA_TYPE
        assert server.output_content_length == str(len(data))


@pytest.mark.parametrize(
    ("size_delta", "digest", "media_type"),
    [
        (1, None, MEDIA_TYPE),
        (0, "0" * 64, MEDIA_TYPE),
        (0, None, "application/octet-stream"),
    ],
)
def test_download_rejects_wrong_size_digest_or_media_type(
    tmp_path: Path,
    size_delta: int,
    digest: str | None,
    media_type: str,
) -> None:
    data = b'{"value":1}\n'
    expected_digest = digest or hashlib.sha256(data).hexdigest()
    with ArtifactServer(data, input_media_type=media_type) as server:
        with pytest.raises(ArtifactTransferError):
            download_artifact(
                server.input_url,
                tmp_path / "downloaded.jsonl",
                expected_size=len(data) + size_delta,
                expected_digest=expected_digest,
                expected_media_type=MEDIA_TYPE,
                timeout_seconds=2,
            )


def test_upload_rejects_output_larger_than_target_and_hides_url(tmp_path: Path) -> None:
    source = tmp_path / "output.jsonl"
    source.write_bytes(b"1234")
    with ArtifactServer(b"") as server:
        with pytest.raises(ArtifactTransferError):
            upload_artifact(
                server.output_url,
                source,
                media_type=MEDIA_TYPE,
                max_size=3,
                timeout_seconds=2,
            )

    secret = "signed-url-must-not-leak"
    with pytest.raises(ArtifactTransferError) as captured:
        download_artifact(
            f"http://127.0.0.1:1/input?signature={secret}",
            tmp_path / "failed.jsonl",
            expected_size=0,
            expected_digest=hashlib.sha256(b"").hexdigest(),
            expected_media_type=MEDIA_TYPE,
            timeout_seconds=0.05,
        )
    assert secret not in str(captured.value)


def test_transfers_stop_cooperatively(tmp_path: Path) -> None:
    source = tmp_path / "source.jsonl"
    source.write_bytes(b'{"value":1}\n')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    with ArtifactServer(source.read_bytes()) as server:
        with pytest.raises(ArtifactTransferStopped):
            download_artifact(
                server.input_url,
                tmp_path / "downloaded.jsonl",
                expected_size=source.stat().st_size,
                expected_digest=digest,
                expected_media_type=MEDIA_TYPE,
                timeout_seconds=2,
                stop_requested=lambda: True,
            )
        with pytest.raises(ArtifactTransferStopped):
            upload_artifact(
                server.output_url,
                source,
                media_type=MEDIA_TYPE,
                max_size=source.stat().st_size,
                timeout_seconds=2,
                stop_requested=lambda: True,
            )
    assert server.get_count == 0
    assert server.put_count == 0
