"""Request/response models for the service.

These wrap the existing databench types (``Sample``, ``Manifest``, ``Recipe``)
rather than redefining them, so the HTTP contract stays in lockstep with the
core schema.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from databench import Manifest, Recipe, Sample


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


class RefInfo(BaseModel):
    name: str
    version: str


class Page(BaseModel):
    """Common pagination envelope: ``total`` is the full count, ``items`` the
    current slice bounded by the server-side limit cap."""

    total: int = Field(description="total number of items available")
    limit: int = Field(description="page size actually applied (<= server cap)")
    offset: int = Field(description="number of items skipped")


class SamplesPage(Page):
    items: list[Sample]


class TransformsPage(Page):
    items: list[TransformInfo]


class RefsPage(Page):
    items: list[RefInfo]


class MaterializeRequest(BaseModel):
    recipe: Recipe
    ref: str | None = None


class VocabularyInfo(BaseModel):
    """List-view summary of a named vocabulary (latest version)."""

    name: str | None = None
    id: str
    dimension: str
    num_terms: int
    status: str | None = None


class VocabulariesPage(Page):
    items: list[VocabularyInfo]


class ValidateSummary(BaseModel):
    """Outcome of checking a dataset's standard labels against a vocabulary."""

    checked: int = Field(description="samples that carried a standard label to check")
    invalid: int = Field(description="checked samples whose label is off-vocabulary")
    offending_values: dict[str, int] = Field(
        default_factory=dict, description="each off-vocabulary value and its frequency"
    )


class ValidateResponse(BaseModel):
    """Validation summary plus the persisted, signal-annotated dataset."""

    summary: ValidateSummary
    dataset: Manifest
