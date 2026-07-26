from __future__ import annotations

import asyncio
import json
import time

from databench.worker.v1 import worker_pb2
from databench_worker.fixture import FixtureCopyAdapter
from databench_worker.registry import CapabilityRegistry
from databench_worker.runner import WorkerService


class FakeContext:
    def __init__(self) -> None:
        self._cancelled = False
        self._callbacks = []

    def add_done_callback(self, callback) -> None:
        self._callbacks.append(callback)

    def cancelled(self) -> bool:
        return self._cancelled

    def cancel(self) -> None:
        self._cancelled = True
        for callback in self._callbacks:
            callback(self)

    async def abort(self, _code, details: str) -> None:
        raise RuntimeError(details)


async def test_rpc_disconnect_cancels_adapter_and_releases_the_batch_slot() -> None:
    registry = CapabilityRegistry()
    registry.register(FixtureCopyAdapter())
    service = WorkerService(registry, "test")
    context = FakeContext()
    request = _wait_request()
    events = []
    started = asyncio.Event()

    async def consume() -> None:
        async for event in service.RunJob(request, context):
            events.append(event.WhichOneof("event"))
            if event.WhichOneof("event") == "started":
                started.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(started.wait(), timeout=1)
    context.cancel()
    await asyncio.wait_for(task, timeout=1)

    assert events[-1] == "cancelled"
    response = await service.CancelJob(
        worker_pb2.CancelJobRequest(
            execution_id=request.execution_id,
            attempt=request.attempt,
            lease_token=request.lease_token,
        ),
        context,
    )
    assert response.result == worker_pb2.CANCEL_RESULT_NOT_FOUND


def _wait_request() -> worker_pb2.RunJobRequest:
    return worker_pb2.RunJobRequest(
        execution_id="execution-disconnect",
        job_id="job-disconnect",
        attempt=1,
        lease_token=b"0123456789abcdef",
        capability_name="fixture.copy",
        capability_version="1",
        parameters=worker_pb2.JsonPayload(
            schema_name="databench.worker.fixture-copy-parameters",
            schema_version="1",
            utf8_json=json.dumps(
                {"mode": "wait_for_cancel", "delay_ms": 1, "steps": 1},
                separators=(",", ":"),
            ).encode(),
        ),
        deadline_unix_ms=time.time_ns() // 1_000_000 + 10_000,
    )
