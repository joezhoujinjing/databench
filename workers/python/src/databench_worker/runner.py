from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import grpc

from databench.worker.v1 import worker_pb2, worker_pb2_grpc

from .registry import CapabilityRegistry, RunContext


@dataclass
class ActiveExecution:
    attempt: int
    lease_token: bytes
    cancellation: asyncio.Event
    done: asyncio.Event


class WorkerService(worker_pb2_grpc.WorkerServiceServicer):
    def __init__(self, registry: CapabilityRegistry, worker_version: str) -> None:
        self._registry = registry
        self._worker_version = worker_version
        self._slot = asyncio.Lock()
        self._active_lock = asyncio.Lock()
        self._active: dict[str, ActiveExecution] = {}

    async def DescribeCapabilities(self, request, context):  # noqa: N802, ARG002
        capabilities = []
        for descriptor in self._registry.descriptors():
            capabilities.append(
                worker_pb2.Capability(
                    name=descriptor.name,
                    version=descriptor.version,
                    mode=worker_pb2.CAPABILITY_MODE_BATCH,
                    parameter_schema_name=descriptor.parameter_schema_name,
                    parameter_schema_version=descriptor.parameter_schema_version,
                    inputs=[
                        worker_pb2.ArtifactContract(name=value.name, media_type=value.media_type)
                        for value in descriptor.inputs
                    ],
                    outputs=[
                        worker_pb2.ArtifactContract(name=value.name, media_type=value.media_type)
                        for value in descriptor.outputs
                    ],
                )
            )
        return worker_pb2.DescribeCapabilitiesResponse(
            worker_version=self._worker_version,
            capabilities=capabilities,
        )

    async def RunJob(self, request, context):  # noqa: N802
        validation_error = _validate_request(request)
        if validation_error:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, validation_error)

        adapter = self._registry.get(request.capability_name, request.capability_version)
        if adapter is None:
            await context.abort(grpc.StatusCode.FAILED_PRECONDITION, "capability is not installed")

        try:
            parameters = adapter.validate_parameters(request.parameters)
        except ValueError as exc:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))

        active = ActiveExecution(
            attempt=request.attempt,
            lease_token=bytes(request.lease_token),
            cancellation=asyncio.Event(),
            done=asyncio.Event(),
        )
        async with self._active_lock:
            if request.execution_id in self._active:
                await context.abort(grpc.StatusCode.ALREADY_EXISTS, "execution is already active")
            if self._active:
                await context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "worker batch slot is busy")
            self._active[request.execution_id] = active
        context.add_done_callback(
            lambda rpc_context: _cancel_if_rpc_cancelled(rpc_context, active)
        )

        try:
            async with self._slot:
                yield worker_pb2.JobEvent(
                    accepted=worker_pb2.AcceptedEvent(timestamp_unix_ms=_now_ms())
                )
                run_context = RunContext(request=request, cancellation=active.cancellation)
                try:
                    async for event in adapter.run(run_context, parameters):
                        yield event
                except ValueError as exc:
                    yield worker_pb2.JobEvent(
                        failed=worker_pb2.FailedEvent(
                            timestamp_unix_ms=_now_ms(),
                            code="invalid_execution_input",
                            message=str(exc),
                            retryable=False,
                        )
                    )
                except Exception:
                    yield worker_pb2.JobEvent(
                        failed=worker_pb2.FailedEvent(
                            timestamp_unix_ms=_now_ms(),
                            code="execution_failed",
                            message="capability execution failed",
                            retryable=False,
                        )
                    )
        except asyncio.CancelledError:
            active.cancellation.set()
            raise
        finally:
            active.done.set()
            async with self._active_lock:
                if self._active.get(request.execution_id) is active:
                    del self._active[request.execution_id]

    async def CancelJob(self, request, context):  # noqa: N802, ARG002
        async with self._active_lock:
            active = self._active.get(request.execution_id)
        if active is None:
            return worker_pb2.CancelJobResponse(result=worker_pb2.CANCEL_RESULT_NOT_FOUND)
        if active.attempt != request.attempt or active.lease_token != bytes(request.lease_token):
            return worker_pb2.CancelJobResponse(result=worker_pb2.CANCEL_RESULT_TOKEN_MISMATCH)

        active.cancellation.set()
        try:
            await asyncio.wait_for(active.done.wait(), timeout=5)
        except TimeoutError:
            await context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "execution did not stop in time")
        return worker_pb2.CancelJobResponse(result=worker_pb2.CANCEL_RESULT_STOPPED)


def _validate_request(request: worker_pb2.RunJobRequest) -> str | None:
    if not request.execution_id or not request.job_id:
        return "execution_id and job_id are required"
    if request.attempt < 1:
        return "attempt must be positive"
    if len(request.lease_token) < 16:
        return "lease_token must contain at least 16 bytes"
    if not request.capability_name or not request.capability_version:
        return "capability name and version are required"
    if not request.HasField("parameters"):
        return "parameters are required"
    if request.deadline_unix_ms <= _now_ms():
        return "job deadline has expired"
    return None


def _cancel_if_rpc_cancelled(context, active: ActiveExecution) -> None:
    if context.cancelled():
        active.cancellation.set()


def _now_ms() -> int:
    return time.time_ns() // 1_000_000
