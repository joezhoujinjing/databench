"""Stable, non-sensitive runtime errors."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimePolicyError(Exception):
    code: str
    message: str
    status: int = 422
    field: str | None = None

    def __str__(self) -> str:
        return self.message

    def to_body(self) -> dict[str, Any]:
        error: dict[str, Any] = {'code': self.code, 'message': self.message}
        if self.field is not None:
            error['field'] = self.field
        return {'error': error}


class UpstreamProtocolError(RuntimePolicyError):
    def __init__(self, message: str = 'EvalScope returned an invalid response') -> None:
        super().__init__('upstream_protocol_error', message, 502)
