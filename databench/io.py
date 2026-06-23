"""Import adapters for getting data *into* databench.

JSONL is the lingua franca of post-training data, so that is the first-class
ingestion path. Records are normalised into the unified :class:`Sample` schema,
with kind auto-detection and tolerance for the common shorthand layouts found in
the wild (e.g. ``chosen``/``rejected`` as plain strings rather than messages).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator, Optional

from .schema import Kind, Sample, parse_sample


def detect_kind(record: dict[str, Any]) -> Kind:
    """Infer the post-training data form from a raw record's shape."""

    if "chosen" in record and "rejected" in record:
        return "preference"
    if "rollouts" in record:
        return "rl"
    if "messages" in record:
        messages = record["messages"] or []
        is_trajectory = any(
            m.get("tool_calls") or m.get("role") == "tool" or m.get("tool_call_id")
            for m in messages
            if isinstance(m, dict)
        )
        return "trajectory" if is_trajectory else "sft"
    raise ValueError(
        "could not detect sample kind; expected one of "
        "'messages', 'chosen'/'rejected', or 'rollouts' in the record"
    )


def _as_messages(value: Any, default_role: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, str):
        return [{"role": default_role, "content": value}]
    if isinstance(value, dict):
        return [value]
    return list(value)


def _as_completion(value: Any) -> Any:
    # A single string completion is the most common shorthand.
    if isinstance(value, str):
        return {"role": "assistant", "content": value}
    return value


def _normalize(record: dict[str, Any], kind: Kind) -> dict[str, Any]:
    r = dict(record)
    if kind == "preference":
        r["prompt"] = _as_messages(r.get("prompt"), "user")
        r["chosen"] = _as_completion(r["chosen"])
        r["rejected"] = _as_completion(r["rejected"])
    elif kind == "rl":
        r["prompt"] = _as_messages(r.get("prompt"), "user")
    # sft / trajectory: `messages` is assumed to already be a list of message dicts
    return r


def record_to_sample(
    record: dict[str, Any], kind: Optional[Kind] = None, source: Optional[str] = None
) -> Sample:
    """Normalise one raw record into a typed :class:`Sample`."""

    kind = kind or detect_kind(record)
    data = _normalize(record, kind)
    data["kind"] = kind
    if source is not None and not data.get("source"):
        data["source"] = source
    return parse_sample(data)


def read_jsonl(
    path: str | Path, kind: Optional[Kind] = None, source: Optional[str] = None
) -> Iterator[Sample]:
    """Stream samples from a JSONL file.

    ``kind`` forces a single form for every line; otherwise each record's kind is
    auto-detected. ``source`` tags provenance when a record doesn't carry its own.
    """

    path = Path(path)
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
            yield record_to_sample(record, kind=kind, source=source or path.stem)
