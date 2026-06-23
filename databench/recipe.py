"""Recipes: the training-facing, reproducible data mixture.

A :class:`Recipe` declares which datasets go into a training run, how much of
each, and the target export format. Materialising a recipe resolves every source
ref to a concrete version and produces a single mixed :class:`Dataset`; because
the recipe + resolved versions hash to a fingerprint, the question "what did this
checkpoint eat?" has an exact, reproducible answer.
"""

from __future__ import annotations

from typing import Literal, Optional

import polars as pl
from pydantic import BaseModel, Field

from .dataset import COLUMNS, Dataset
from .hashing import hash_obj

TargetFormat = Literal["messages-jsonl", "trl"]


class RecipeSource(BaseModel):
    dataset: str  # ref name or concrete version
    weight: float | None = None
    max_samples: int | None = None


class Recipe(BaseModel):
    name: str
    sources: list[RecipeSource]
    target_format: TargetFormat = "messages-jsonl"
    target_size: int | None = None  # total rows; splits across sources by weight
    seed: int = 0

    def fingerprint(self, resolved_versions: dict[str, str]) -> str:
        return hash_obj({"recipe": self.model_dump(mode="json"), "resolved": resolved_versions})


def _source_count(height: int, source: RecipeSource) -> int:
    n = height
    if source.max_samples is not None:
        n = min(n, source.max_samples)
    return n


def mix(recipe: Recipe, frames: list[tuple[RecipeSource, pl.DataFrame]]) -> Dataset:
    """Combine source frames into one mixed dataset per the recipe."""

    base_counts = [_source_count(f.height, src) for src, f in frames]

    if recipe.target_size is not None:
        total_weight = sum((src.weight or 1.0) for src, _ in frames)
        counts = []
        for (src, f), base in zip(frames, base_counts):
            share = (src.weight or 1.0) / total_weight
            counts.append(min(base, round(share * recipe.target_size)))
    else:
        counts = base_counts

    parts = []
    for (src, f), count in zip(frames, counts):
        sub = f.select(COLUMNS)
        if count < f.height:
            sub = sub.sample(n=count, seed=recipe.seed)
        parts.append(sub)

    combined = pl.concat(parts) if parts else pl.DataFrame(schema={c: pl.Utf8 for c in COLUMNS})
    return Dataset.from_frame(combined, name=recipe.name)
