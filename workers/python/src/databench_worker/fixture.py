from __future__ import annotations

import asyncio
import hashlib
import json
import time
import urllib.request
from collections.abc import AsyncIterator
from dataclasses import dataclass

from databench.worker.v1 import worker_pb2

from .registry import ArtifactContract, CapabilityDescriptor, RunContext


@dataclass(frozen=True)
class FixtureParameters:
    mode: str
    delay_ms: int
    steps: int


class FixtureCopyAdapter:
    """Test-only adapter used to prove the cross-language Worker lifecycle."""

    descriptor = CapabilityDescriptor(
        name="fixture.copy",
        version="1",
        parameter_schema_name="databench.worker.fixture-copy-parameters",
        parameter_schema_version="1",
        inputs=(ArtifactContract("input", "application/octet-stream"),),
        outputs=(ArtifactContract("output", "application/octet-stream"),),
    )

    def validate_parameters(self, payload: worker_pb2.JsonPayload) -> FixtureParameters:
        if payload.schema_name != self.descriptor.parameter_schema_name:
            raise ValueError("unsupported fixture parameter schema")
        if payload.schema_version != self.descriptor.parameter_schema_version:
            raise ValueError("unsupported fixture parameter schema version")
        try:
            value = json.loads(payload.utf8_json.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("fixture parameters must be valid UTF-8 JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("fixture parameters must be an object")
        allowed = {"mode", "delay_ms", "steps"}
        if set(value) - allowed:
            raise ValueError("fixture parameters contain unknown fields")
        mode = value.get("mode", "complete")
        delay_ms = value.get("delay_ms", 1)
        steps = value.get("steps", 1)
        if mode not in {
            "complete",
            "wait_for_cancel",
            "eof_without_terminal",
            "terminal_then_wait_for_cancel",
            "terminal_then_raise",
        }:
            raise ValueError("unsupported fixture mode")
        if not isinstance(delay_ms, int) or isinstance(delay_ms, bool) or not 0 <= delay_ms <= 5000:
            raise ValueError("fixture delay_ms is outside the allowed range")
        if not isinstance(steps, int) or isinstance(steps, bool) or not 1 <= steps <= 1000:
            raise ValueError("fixture steps is outside the allowed range")
        return FixtureParameters(mode=mode, delay_ms=delay_ms, steps=steps)

    async def run(
        self,
        context: RunContext,
        parameters: object,
    ) -> AsyncIterator[worker_pb2.JobEvent]:
        if not isinstance(parameters, FixtureParameters):
            raise TypeError("fixture parameters were not validated")

        yield worker_pb2.JobEvent(started=worker_pb2.StartedEvent(timestamp_unix_ms=_now_ms()))

        for index in range(parameters.steps):
            if await _wait_or_cancel(context, parameters.delay_ms):
                yield _cancelled_event()
                return
            yield worker_pb2.JobEvent(
                progress=worker_pb2.ProgressEvent(
                    timestamp_unix_ms=_now_ms(),
                    phase="copying",
                    completed_units=index + 1,
                    total_units=parameters.steps,
                )
            )

        if parameters.mode == "wait_for_cancel":
            await context.cancellation.wait()
            yield _cancelled_event()
            return

        if parameters.mode == "eof_without_terminal":
            return

        if len(context.request.inputs) != 1 or len(context.request.outputs) != 1:
            raise ValueError("fixture.copy requires exactly one input and one output")

        input_artifact = context.request.inputs[0]
        output_target = context.request.outputs[0]
        data = await asyncio.to_thread(_read_url, input_artifact.read_url)
        if len(data) != input_artifact.size:
            raise ValueError("fixture input size does not match its descriptor")
        if len(data) > output_target.max_size:
            raise ValueError("fixture output exceeds max_size")
        await asyncio.to_thread(_write_url, output_target.write_url, data, output_target.media_type)

        yield worker_pb2.JobEvent(
            completed=worker_pb2.CompletedEvent(
                timestamp_unix_ms=_now_ms(),
                outputs=[
                    worker_pb2.OutputArtifact(
                        name=output_target.name,
                        size=len(data),
                        digest=hashlib.sha256(data).hexdigest(),
                        record_count=0,
                    )
                ],
            )
        )
        if parameters.mode == "terminal_then_wait_for_cancel":
            await context.cancellation.wait()
        elif parameters.mode == "terminal_then_raise":
            raise RuntimeError("fixture failure after terminal")


async def _wait_or_cancel(context: RunContext, delay_ms: int) -> bool:
    if context.cancellation.is_set():
        return True
    try:
        await asyncio.wait_for(context.cancellation.wait(), timeout=delay_ms / 1000)
        return True
    except TimeoutError:
        return False


def _read_url(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=5) as response:
        return response.read()


def _write_url(url: str, data: bytes, media_type: str) -> None:
    request = urllib.request.Request(
        url,
        data=data,
        method="PUT",
        headers={"Content-Type": media_type},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        if not 200 <= response.status < 300:
            raise ValueError("fixture output upload failed")


def _cancelled_event() -> worker_pb2.JobEvent:
    return worker_pb2.JobEvent(
        cancelled=worker_pb2.CancelledEvent(
            timestamp_unix_ms=_now_ms(),
            message="execution cancelled",
        )
    )


def _now_ms() -> int:
    return time.time_ns() // 1_000_000
