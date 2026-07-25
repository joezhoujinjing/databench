from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Protocol

from databench.worker.v1 import worker_pb2


@dataclass(frozen=True)
class ArtifactContract:
    name: str
    media_type: str


@dataclass(frozen=True)
class CapabilityDescriptor:
    name: str
    version: str
    parameter_schema_name: str
    parameter_schema_version: str
    inputs: tuple[ArtifactContract, ...] = ()
    outputs: tuple[ArtifactContract, ...] = ()


@dataclass(frozen=True)
class RunContext:
    request: worker_pb2.RunJobRequest
    cancellation: "Cancellation"


class Cancellation(Protocol):
    def is_set(self) -> bool: ...

    async def wait(self) -> bool: ...


class CapabilityAdapter(Protocol):
    descriptor: CapabilityDescriptor

    def validate_parameters(self, payload: worker_pb2.JsonPayload) -> object: ...

    def run(
        self,
        context: RunContext,
        parameters: object,
    ) -> AsyncIterator[worker_pb2.JobEvent]: ...


class CapabilityRegistry:
    def __init__(self) -> None:
        self._adapters: dict[tuple[str, str], CapabilityAdapter] = {}

    def register(self, adapter: CapabilityAdapter) -> None:
        key = (adapter.descriptor.name, adapter.descriptor.version)
        if key in self._adapters:
            raise ValueError(f"duplicate capability: {key[0]}@{key[1]}")
        self._adapters[key] = adapter

    def get(self, name: str, version: str) -> CapabilityAdapter | None:
        return self._adapters.get((name, version))

    def descriptors(self) -> tuple[CapabilityDescriptor, ...]:
        return tuple(
            adapter.descriptor
            for _, adapter in sorted(self._adapters.items(), key=lambda item: item[0])
        )
