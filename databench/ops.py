"""A starter library of built-in transforms.

These cover the everyday post-training data chores and double as worked examples
of the transform contract: take a Dataset (plus typed params), return a Dataset
or Polars frame. Filtering/sampling stay in Polars (fast, columnar); enrichment
round-trips through samples to show the non-destructive ``signals`` pattern.
"""

from __future__ import annotations

from typing import Any

import polars as pl
from pydantic import BaseModel

from .dataset import Dataset
from .schema import Message, Sample
from .transform import transform


@transform()
def dedup(ds: Dataset) -> Dataset:
    """Drop exact-duplicate samples (same content id), keeping the first."""

    frame = ds.polars().unique(subset=["id"], keep="first", maintain_order=True)
    return Dataset.from_frame(frame, name=ds.name)


class SignalFilterParams(BaseModel):
    key: str
    min: float | None = None
    max: float | None = None


@transform(params=SignalFilterParams)
def filter_by_signal(ds: Dataset, p: SignalFilterParams) -> Dataset:
    """Keep rows whose numeric ``signals[key]`` falls within [min, max]."""

    value = pl.col("signals").str.json_path_match("$." + p.key).cast(pl.Float64, strict=False)
    cond = pl.lit(True)
    if p.min is not None:
        cond = cond & (value >= p.min)
    if p.max is not None:
        cond = cond & (value <= p.max)
    frame = ds.polars().filter(cond)
    return Dataset.from_frame(frame, name=ds.name)


class SampleNParams(BaseModel):
    n: int
    seed: int = 0


@transform(params=SampleNParams)
def sample_n(ds: Dataset, p: SampleNParams) -> Dataset:
    """Randomly subsample down to ``n`` rows (no-op if already smaller)."""

    frame = ds.polars()
    if p.n < frame.height:
        frame = frame.sample(n=p.n, seed=p.seed)
    return Dataset.from_frame(frame, name=ds.name)


@transform()
def enrich_length(ds: Dataset) -> Dataset:
    """Attach char/word length signals (non-destructive enrichment)."""

    out = []
    for s in ds.to_samples():
        text = _sample_text(s)
        s.signals = {**s.signals, "char_len": len(text), "word_len": len(text.split())}
        out.append(s)
    return Dataset.from_samples(out, name=ds.name)


def _message_text(messages: list[Message]) -> str:
    return " ".join(m.content for m in messages if m.content)


def _sample_text(sample: Sample) -> str:
    """Best-effort plain text of a sample, used for length-style signals."""

    kind = sample.kind
    if kind in ("sft", "trajectory"):
        return _message_text(sample.messages)
    if kind == "preference":
        chosen = sample.chosen if isinstance(sample.chosen, list) else [sample.chosen]
        return _message_text(list(sample.prompt) + chosen)
    if kind == "rl":
        return _message_text(list(sample.prompt))
    return ""
