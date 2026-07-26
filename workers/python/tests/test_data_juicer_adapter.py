from __future__ import annotations

import asyncio
import hashlib
import json
import socket
import tempfile
import time
from pathlib import Path

import pytest

from databench.worker.v1 import worker_pb2
from databench_worker.adapters.data_juicer import (
    FIXED_PROCESS,
    MEDIA_TYPE,
    PARAMETER_SCHEMA,
    PARAMETER_VERSION,
    AdapterFailure,
    DataJuicerBatchAdapter,
    _report_process_failure,
    _validate_artifact_contract,
)
from databench_worker.adapters.data_juicer import _validate_input, _write_retained_output
from databench_worker.data_juicer_child import _connect_local_only, _runtime_install_disabled
from databench_worker.registry import RunContext

from http_artifact_server import ArtifactServer


def parameter_payload(value: object | None = None) -> worker_pb2.JsonPayload:
    parameters = value if value is not None else {"np": 1, "process": list(FIXED_PROCESS)}
    return worker_pb2.JsonPayload(
        schema_name=PARAMETER_SCHEMA,
        schema_version=PARAMETER_VERSION,
        utf8_json=json.dumps(parameters, separators=(",", ":")).encode(),
    )


def test_parameters_accept_only_the_fixed_plan(tmp_path: Path) -> None:
    adapter = DataJuicerBatchAdapter(tmp_path)
    parsed = adapter.validate_parameters(parameter_payload())
    assert parsed.np == 1
    assert parsed.process == FIXED_PROCESS

    invalid_payloads = [
        worker_pb2.JsonPayload(
            schema_name="wrong",
            schema_version=PARAMETER_VERSION,
            utf8_json=b"{}",
        ),
        parameter_payload({"np": 2, "process": list(FIXED_PROCESS)}),
        parameter_payload({"np": 1, "process": []}),
        parameter_payload(
            {
                "np": 1,
                "process": [
                    *list(FIXED_PROCESS),
                    {"language_id_score_filter": {"lang": "en"}},
                ],
            }
        ),
        parameter_payload({"np": 1, "process": list(FIXED_PROCESS), "path": "/tmp/input"}),
    ]
    for payload in invalid_payloads:
        with pytest.raises(ValueError):
            adapter.validate_parameters(payload)

    duplicate = worker_pb2.JsonPayload(
        schema_name=PARAMETER_SCHEMA,
        schema_version=PARAMETER_VERSION,
        utf8_json=b'{"np":1,"np":1,"process":[]}',
    )
    with pytest.raises(ValueError):
        adapter.validate_parameters(duplicate)


def test_input_and_retained_output_are_strict_and_bounded(tmp_path: Path) -> None:
    identity = {"record_id": f"rec_{'1' * 64}", "record_digest": "a" * 64}
    source = tmp_path / "source.jsonl"
    source.write_text(json.dumps({**identity, "text": "long enough"}) + "\n", encoding="utf-8")
    assert _validate_input(source) == 1

    retained = tmp_path / "retained.jsonl"
    assert _write_retained_output(source, retained, 1_000) == 1
    assert json.loads(retained.read_text()) == identity
    assert "text" not in retained.read_text()

    malformed = tmp_path / "malformed.jsonl"
    malformed.write_text(json.dumps({**identity, "text": "value", "unknown": True}) + "\n")
    with pytest.raises(ValueError):
        _validate_input(malformed)
    with pytest.raises(ValueError):
        _write_retained_output(malformed, tmp_path / "malformed-output.jsonl", 1_000)
    with pytest.raises(AdapterFailure, match="exceeds"):
        _write_retained_output(source, tmp_path / "too-small.jsonl", 1)

    oversized = run_request(
        "http://127.0.0.1/input",
        "http://127.0.0.1/output",
        size=0,
        digest="0" * 64,
    )
    oversized.outputs[0].max_size = 1024 * 1024 * 1024 + 1
    with pytest.raises(AdapterFailure, match="artifact limit"):
        _validate_artifact_contract(RunContext(request=oversized, cancellation=asyncio.Event()))


def test_process_failure_diagnostic_fingerprints_but_never_prints_the_log_tail(capsys) -> None:
    log_tail = b"sample=private signed=https://objects.example.test/output?token=secret-token"

    _report_process_failure(17, log_tail)

    captured = capsys.readouterr()
    diagnostic = json.loads(captured.err)
    assert diagnostic == {
        "component": "data_juicer_adapter",
        "code": "data_juicer_process_failed",
        "returncode": 17,
        "log_tail_bytes": len(log_tail),
        "log_tail_sha256": hashlib.sha256(log_tail).hexdigest(),
    }
    assert log_tail.decode() not in captured.err
    assert "secret-token" not in captured.err


async def test_real_data_juicer_100_row_semantics_and_cleanup() -> None:
    rows, expected = semantic_fixture(100)
    input_bytes = encode_rows(rows)
    input_digest = hashlib.sha256(input_bytes).hexdigest()
    with tempfile.TemporaryDirectory(prefix="databench-worker-test-", dir="/tmp") as temp_value, ArtifactServer(
        input_bytes
    ) as server:
        temp_root = Path(temp_value)
        adapter = DataJuicerBatchAdapter(temp_root)
        parameters = adapter.validate_parameters(parameter_payload())
        request = run_request(
            server.input_url,
            server.output_url,
            size=len(input_bytes),
            digest=input_digest,
        )
        events = [
            event
            async for event in adapter.run(
                RunContext(request=request, cancellation=asyncio.Event()), parameters
            )
        ]

        assert [event.WhichOneof("event") for event in events if event.WhichOneof("event") != "heartbeat"] == [
            "started",
            "progress",
            "progress",
            "completed",
        ]
        progress = [event.progress for event in events if event.WhichOneof("event") == "progress"]
        assert [event.phase for event in progress] == ["input_ready", "output_ready"]
        assert [(event.completed_units, event.total_units) for event in progress] == [
            (0, len(rows)),
            (len(rows), len(rows)),
        ]
        terminal = events[-1].completed.outputs[0]
        assert terminal.record_count == len(expected)
        assert terminal.digest == hashlib.sha256(server.output_bytes or b"").hexdigest()
        retained = [json.loads(line) for line in (server.output_bytes or b"").splitlines()]
        assert retained == expected
        assert all(set(row) == {"record_id", "record_digest"} for row in retained)
        assert server.output_content_type == MEDIA_TYPE
        assert server.output_content_length == str(terminal.size)
        assert input_bytes == encode_rows(rows)

        assert list(temp_root.iterdir()) == []


async def test_real_data_juicer_cancellation_is_terminal_and_cleans_temp() -> None:
    rows, _ = semantic_fixture(10_000)
    input_bytes = encode_rows(rows)
    cancellation = asyncio.Event()

    with tempfile.TemporaryDirectory(prefix="databench-worker-test-", dir="/tmp") as temp_value, ArtifactServer(
        input_bytes
    ) as server:
        temp_root = Path(temp_value)
        adapter = DataJuicerBatchAdapter(temp_root)
        context = RunContext(
            request=run_request(
                server.input_url,
                server.output_url,
                size=len(input_bytes),
                digest=hashlib.sha256(input_bytes).hexdigest(),
            ),
            cancellation=cancellation,
        )
        event_types: list[str] = []
        async for event in adapter.run(context, adapter.validate_parameters(parameter_payload())):
            event_type = event.WhichOneof("event")
            event_types.append(event_type)
            if event_type == "progress" and event.progress.phase == "input_ready":
                asyncio.get_running_loop().call_later(0.1, cancellation.set)

        assert event_types[-1] == "cancelled"
        assert "completed" not in event_types
        assert "failed" not in event_types
        assert server.put_count == 0

        assert list(temp_root.iterdir()) == []


def test_child_allows_unix_sockets_but_blocks_network_and_installs() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as inet:
        with pytest.raises(OSError, match="network access is disabled"):
            _connect_local_only(inet, ("127.0.0.1", 1))
    with pytest.raises(ImportError, match="runtime dependency installation"):
        _runtime_install_disabled(object, "package")

    if not hasattr(socket, "AF_UNIX"):
        return
    with tempfile.TemporaryDirectory(prefix="dbw-", dir="/tmp") as value:
        socket_path = Path(value) / "local.sock"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(socket_path))
            listener.listen(1)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                _connect_local_only(client, str(socket_path))
                connection, _ = listener.accept()
                connection.close()


def semantic_fixture(count: int) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    rows: list[dict[str, str]] = []
    expected: list[dict[str, str]] = []
    previous_long = ""
    for index in range(count):
        offset = index % 10
        if offset == 0:
            text = f"short-{index}"
        elif index == 1:
            text = "   Shared\ttext with enough deterministic characters for the fixed filter.   "
        elif index == 2:
            text = "Shared text with enough deterministic characters for the fixed filter."
        elif offset == 2:
            text = previous_long
        else:
            text = f"Record {index:06d} has enough deterministic characters for the fixed filter."
        if offset == 1:
            previous_long = text
        row = {
            "record_id": f"rec_{index:064x}",
            "record_digest": f"{count + index:064x}",
            "text": text,
        }
        rows.append(row)
        if offset not in {0, 2}:
            expected.append({"record_id": row["record_id"], "record_digest": row["record_digest"]})
    return rows, expected


def encode_rows(rows: list[dict[str, str]]) -> bytes:
    return b"".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        for row in rows
    )


def run_request(
    input_url: str,
    output_url: str,
    *,
    size: int,
    digest: str,
) -> worker_pb2.RunJobRequest:
    return worker_pb2.RunJobRequest(
        execution_id="execution.1",
        job_id="job.1",
        attempt=1,
        lease_token=b"0123456789abcdef",
        capability_name="data_juicer.batch",
        capability_version="1",
        parameters=parameter_payload(),
        inputs=[
            worker_pb2.InputArtifact(
                name="input",
                read_url=input_url,
                media_type=MEDIA_TYPE,
                size=size,
                digest=digest,
            )
        ],
        outputs=[
            worker_pb2.OutputTarget(
                name="output",
                write_url=output_url,
                media_type=MEDIA_TYPE,
                max_size=10 * 1024 * 1024,
            )
        ],
        deadline_unix_ms=time.time_ns() // 1_000_000 + 120_000,
    )
