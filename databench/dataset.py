"""Immutable, content-addressed datasets.

A :class:`Dataset` is a versioned collection of samples backed by a Polars
frame with a canonical column layout. Two invariants make versioning and
lineage work:

* **Immutable** - transforms never mutate a dataset; they build a new one.
* **Content-addressed** - the ``version`` is derived purely from the rows
  (including their ``signals``), in an order-independent way. Identical content
  always yields the same version; any enrichment yields a new one.

Internally each row stores canonical-JSON strings for ``payload`` (the
identity-bearing content), ``meta`` and ``signals``. Keeping them canonical at
construction time is what makes the row digest - and therefore the dataset
version - stable regardless of how a transform produced the frame.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator

import polars as pl
import pyarrow as pa
from pydantic import BaseModel

from .hashing import HASH_ALGO, canonical_json, hash_obj, hash_text, hash_unordered
from .schema import SCHEMA_VERSION, Sample, parse_sample

# Canonical physical layout. `payload` holds the identity content (incl. kind);
# `meta`/`signals` are open dicts; `id`/`row_digest` are derived.
COLUMNS = ["id", "row_digest", "kind", "source", "payload", "meta", "signals"]


class Manifest(BaseModel):
    """Lightweight, serialisable description of a dataset version."""

    name: str | None = None
    version: str
    schema_version: str = SCHEMA_VERSION
    hash_algo: str = HASH_ALGO
    num_rows: int
    kinds: dict[str, int]
    columns: list[str] = COLUMNS
    created_at: datetime


def _row_digest(payload_json: str, source: str | None, meta_json: str, signals_json: str) -> str:
    # All inputs are already canonical JSON strings (or None), so concatenating
    # and hashing is stable. The NUL separator avoids field-boundary collisions.
    return hash_text("\x00".join([payload_json, source or "", meta_json, signals_json]))


def _build(raw_rows: Iterable[dict[str, Any]], name: str | None) -> "Dataset":
    """Normalise raw python rows into a canonical frame + manifest.

    Each raw row must provide ``content`` (the identity payload dict, including
    ``kind``), plus optional ``source``/``meta``/``signals``. This is the single
    construction path shared by :meth:`Dataset.from_samples` and
    :meth:`Dataset.from_frame`, so digests are computed identically everywhere.
    """

    ids: list[str] = []
    digests: list[str] = []
    kinds: list[str] = []
    sources: list[str | None] = []
    payloads: list[str] = []
    metas: list[str] = []
    signals: list[str] = []

    for row in raw_rows:
        content = row["content"]
        source = row.get("source")
        meta = row.get("meta") or {}
        sig = row.get("signals") or {}

        payload_json = canonical_json(content)
        meta_json = canonical_json(meta)
        signals_json = canonical_json(sig)

        sid = hash_text(payload_json)  # id == hash of canonical content
        digest = _row_digest(payload_json, source, meta_json, signals_json)

        ids.append(sid)
        digests.append(digest)
        kinds.append(content.get("kind", "unknown"))
        sources.append(source)
        payloads.append(payload_json)
        metas.append(meta_json)
        signals.append(signals_json)

    frame = pl.DataFrame(
        {
            "id": ids,
            "row_digest": digests,
            "kind": kinds,
            "source": sources,
            "payload": payloads,
            "meta": metas,
            "signals": signals,
        },
        schema={c: pl.Utf8 for c in COLUMNS},
    )

    version = hash_unordered(digests) if digests else hash_text("empty")
    manifest = Manifest(
        name=name,
        version=version,
        num_rows=len(ids),
        kinds=dict(Counter(kinds)),
        created_at=datetime.now(timezone.utc),
    )
    return Dataset(frame, manifest)


class Dataset:
    def __init__(self, frame: pl.DataFrame, manifest: Manifest):
        self._frame = frame
        self.manifest = manifest

    # -- construction --------------------------------------------------------

    @classmethod
    def from_samples(cls, samples: Iterable[Sample], name: str | None = None) -> "Dataset":
        rows = []
        for s in samples:
            rows.append(
                {
                    "content": s.content_dict(),
                    "source": s.source,
                    "meta": s.meta,
                    "signals": s.signals,
                }
            )
        return _build(rows, name)

    @classmethod
    def from_frame(cls, frame: pl.DataFrame, name: str | None = None) -> "Dataset":
        """Rebuild a canonical dataset from a (possibly transformed) frame.

        The frame must carry at least ``payload`` and may carry
        ``source``/``meta``/``signals``. Digests and version are recomputed, so
        a transform can return a plain Polars frame without worrying about
        identity bookkeeping.
        """

        missing = {"payload"} - set(frame.columns)
        if missing:
            raise ValueError(f"frame is missing required columns: {missing}")

        cols = frame.columns
        rows = []
        for r in frame.iter_rows(named=True):
            content = _loads(r["payload"])
            rows.append(
                {
                    "content": content,
                    "source": r["source"] if "source" in cols else None,
                    "meta": _loads(r["meta"]) if "meta" in cols and r["meta"] else {},
                    "signals": _loads(r["signals"]) if "signals" in cols and r["signals"] else {},
                }
            )
        return _build(rows, name)

    # -- access --------------------------------------------------------------

    @property
    def version(self) -> str:
        return self.manifest.version

    @property
    def name(self) -> str | None:
        return self.manifest.name

    def __len__(self) -> int:
        return self.manifest.num_rows

    def __repr__(self) -> str:
        return f"Dataset(name={self.manifest.name!r}, version={self.version[:12]}, rows={len(self)})"

    def polars(self) -> pl.DataFrame:
        """Return a clone of the underlying frame (safe to mutate)."""

        return self._frame.clone()

    def arrow(self) -> pa.Table:
        return self._frame.to_arrow()

    def to_samples(self) -> Iterator[Sample]:
        for r in self._frame.iter_rows(named=True):
            obj = _loads(r["payload"])
            obj["source"] = r["source"]
            obj["meta"] = _loads(r["meta"]) if r["meta"] else {}
            obj["signals"] = _loads(r["signals"]) if r["signals"] else {}
            yield parse_sample(obj)

    def head(self, n: int = 5) -> list[Sample]:
        out = []
        for i, s in enumerate(self.to_samples()):
            if i >= n:
                break
            out.append(s)
        return out


def _loads(s: str) -> dict[str, Any]:
    return json.loads(s) if s else {}
