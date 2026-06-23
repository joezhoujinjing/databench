"""Content hashing primitives.

Everything in databench is content-addressed: a sample's identity, a dataset
version, a transform's cache key. All of those flow through the helpers here so
that hashing is stable and consistent across the codebase.

We prefer BLAKE3 (fast, modern) but fall back to ``hashlib.blake2b`` when the
optional native extension is unavailable, so importing databench never hard
fails on a fresh machine.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

try:  # pragma: no cover - exercised implicitly depending on environment
    from blake3 import blake3 as _blake3

    def _digest(data: bytes) -> str:
        return _blake3(data).hexdigest()

    HASH_ALGO = "blake3"
except Exception:  # pragma: no cover
    import hashlib

    def _digest(data: bytes) -> str:
        return hashlib.blake2b(data, digest_size=32).hexdigest()

    HASH_ALGO = "blake2b"


def canonical_json(obj: Any) -> str:
    """Deterministic JSON encoding used everywhere we hash structured data.

    Keys are sorted and whitespace is stripped so that two semantically equal
    objects always produce the same bytes (and therefore the same hash).
    """

    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )


def hash_bytes(data: bytes) -> str:
    return _digest(data)


def hash_text(text: str) -> str:
    return _digest(text.encode("utf-8"))


def hash_obj(obj: Any) -> str:
    """Hash an arbitrary JSON-serialisable object via its canonical encoding."""

    return _digest(canonical_json(obj).encode("utf-8"))


def hash_unordered(hexes: Iterable[str]) -> str:
    """Combine many hashes into one in an order-independent way.

    Used to compute a dataset version from its row digests: reordering rows must
    not change the version.
    """

    joined = "\n".join(sorted(hexes))
    return _digest(joined.encode("utf-8"))
