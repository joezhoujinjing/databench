"""Request/response models for the service.

These wrap the existing databench types (``Sample``, ``Manifest``, ``Recipe``)
rather than redefining them, so the HTTP contract stays in lockstep with the
core schema.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from databench import Recipe, Sample


class IngestSamplesRequest(BaseModel):
    name: str | None = None
    message: str | None = None
    samples: list[Sample]


class TransformRunRequest(BaseModel):
    inputs: list[str] = Field(..., description="dataset refs or versions")
    params: dict[str, Any] = Field(default_factory=dict)
    ref: str | None = None


class TransformInfo(BaseModel):
    name: str
    version: str
    params_schema: dict[str, Any] | None = None


class SamplesPage(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[Sample]


class MaterializeRequest(BaseModel):
    recipe: Recipe
    ref: str | None = None
