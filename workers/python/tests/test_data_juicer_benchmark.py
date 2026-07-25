from __future__ import annotations

import asyncio
import hashlib
import json
import os
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
    DataJuicerBatchAdapter,
)
from databench_worker.registry import RunContext

from http_artifact_server import ArtifactServer


RUN_BENCHMARK = os.environ.get("RUN_DATA_JUICER_BENCHMARKS") == "1"


@pytest.mark.skipif(not RUN_BENCHMARK, reason="set RUN_DATA_JUICER_BENCHMARKS=1")
def test_data_juicer_10k_100k_repeat_is_deterministic() -> None:
    reports = [run_benchmark(10_000), run_benchmark(100_000), run_benchmark(100_000)]
    assert reports[1]["output_digest"] == reports[2]["output_digest"]
    assert reports[1]["retained"] == reports[2]["retained"] == 80_000
    print(json.dumps({"data_juicer_benchmark": reports}, separators=(",", ":")))


def run_benchmark(count: int) -> dict[str, object]:
    input_bytes = benchmark_rows(count)
    input_digest = hashlib.sha256(input_bytes).hexdigest()
    with tempfile.TemporaryDirectory(prefix="databench-benchmark-", dir="/tmp") as temp_value:
        with ArtifactServer(input_bytes) as server:
            adapter = DataJuicerBatchAdapter(Path(temp_value))
            started = time.perf_counter()
            events = asyncio.run(
                collect_events(
                    adapter,
                    RunContext(
                        request=worker_pb2.RunJobRequest(
                            execution_id=f"benchmark.{count}",
                            job_id=f"benchmark.{count}",
                            attempt=1,
                            lease_token=b"0123456789abcdef",
                            capability_name="data_juicer.batch",
                            capability_version="1",
                            parameters=parameters(),
                            inputs=[
                                worker_pb2.InputArtifact(
                                    name="input",
                                    read_url=server.input_url,
                                    media_type=MEDIA_TYPE,
                                    size=len(input_bytes),
                                    digest=input_digest,
                                )
                            ],
                            outputs=[
                                worker_pb2.OutputTarget(
                                    name="output",
                                    write_url=server.output_url,
                                    media_type=MEDIA_TYPE,
                                    max_size=1024 * 1024 * 1024,
                                )
                            ],
                            deadline_unix_ms=time.time_ns() // 1_000_000 + 15 * 60_000,
                        ),
                        cancellation=asyncio.Event(),
                    ),
                )
            )
            elapsed = time.perf_counter() - started
            terminal = events[-1]
            assert terminal.WhichOneof("event") == "completed", events
            output = terminal.completed.outputs[0]
            assert output.record_count == count * 8 // 10
            assert output.digest == hashlib.sha256(server.output_bytes or b"").hexdigest()
            assert list(Path(temp_value).iterdir()) == []
            return {
                "rows": count,
                "retained": output.record_count,
                "seconds": round(elapsed, 3),
                "rows_per_second": round(count / elapsed, 1),
                "output_digest": output.digest,
            }


async def collect_events(
    adapter: DataJuicerBatchAdapter,
    context: RunContext,
) -> list[worker_pb2.JobEvent]:
    validated = adapter.validate_parameters(parameters())
    return [event async for event in adapter.run(context, validated)]


def parameters() -> worker_pb2.JsonPayload:
    return worker_pb2.JsonPayload(
        schema_name=PARAMETER_SCHEMA,
        schema_version=PARAMETER_VERSION,
        utf8_json=json.dumps(
            {"np": 1, "process": list(FIXED_PROCESS)}, separators=(",", ":")
        ).encode(),
    )


def benchmark_rows(count: int) -> bytes:
    lines: list[bytes] = []
    previous = ""
    for index in range(count):
        offset = index % 10
        if offset == 0:
            text = f"short-{index}"
        elif offset == 2:
            text = previous
        else:
            text = f"Record {index:06d} has enough deterministic characters for the fixed filter."
        if offset == 1:
            previous = text
        lines.append(
            json.dumps(
                {
                    "record_id": f"rec_{index:064x}",
                    "record_digest": f"{count + index:064x}",
                    "text": text,
                },
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
    return b"".join(lines)
