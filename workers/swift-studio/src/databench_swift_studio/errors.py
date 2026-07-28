"""Typed, sanitized errors for the Swift Studio Provider control API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class ProviderError(Exception):
    code: str
    message: str
    status: int
    path: str | None = None

    def to_body(self) -> dict[str, Any]:
        return {
            'error': {
                'code': self.code,
                'message': self.message,
            }
        }
