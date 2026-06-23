"""Controlled vocabularies: canonical terms with aliases.

A :class:`Vocabulary` is a content-addressed registry that maps many raw surface
forms onto a single canonical term within one *dimension* (e.g. ``brand`` or
``unit``). It is the controlled-vocabulary sibling of :class:`~databench.schema.Sample`
and follows the same two rules:

* **Content addressing** - ``Vocabulary.id`` hashes the *identity payload only*
  (the dimension plus each term's canonical + aliases). ``name``/``meta``/
  ``source``/``signals`` and per-term ``meta`` are excluded, so renaming a
  vocabulary or annotating a term never changes its identity. Curating the terms
  does - a curated edit is simply a new content-addressed version.
* **One canonical per alias** - within a vocabulary every alias resolves to
  exactly one canonical, and canonicals are unique. Violations raise at
  construction time (a pydantic validation error), so a malformed vocabulary can
  never be persisted.

The module also carries the three label-driven operations used to bootstrap and
apply a vocabulary over a dataset of SFT samples whose assistant turn is a JSON
object of the form ``{raw_brand, std_brand, raw_unit, std_unit, params{}}``:

* :func:`derive_vocabulary` - bootstrap a draft from the ``std_*`` / ``raw_*``
  labels already present in a dataset.
* :func:`normalize_samples` - rewrite ``std_*`` to the canonical of ``raw_*``.
* :func:`validate_samples` - flag samples whose ``std_*`` is not a known
  canonical (non-destructive ``signals`` enrichment).
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from typing import Any, Iterable, Literal

from pydantic import BaseModel, Field, computed_field, model_validator

from .hashing import hash_obj
from .schema import Sample

Dimension = Literal["brand", "unit"]

# Which assistant-payload keys carry the raw/standard label for each dimension.
_DIMENSION_KEYS: dict[str, tuple[str, str]] = {
    "brand": ("raw_brand", "std_brand"),
    "unit": ("raw_unit", "std_unit"),
}


class Term(BaseModel):
    """One canonical term plus the raw forms that map onto it."""

    canonical: str
    aliases: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)


class Vocabulary(BaseModel):
    """A controlled, content-addressed registry of canonical terms."""

    name: str | None = None
    dimension: Dimension
    terms: list[Term] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)
    source: str | None = None
    signals: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_invariants(self) -> "Vocabulary":
        seen: set[str] = set()
        index: dict[str, str] = {}
        for term in self.terms:
            if term.canonical in seen:
                raise ValueError(f"duplicate canonical term: {term.canonical!r}")
            seen.add(term.canonical)
            for alias in term.aliases:
                if alias == term.canonical:
                    continue
                existing = index.get(alias)
                if existing is not None and existing != term.canonical:
                    raise ValueError(
                        f"alias {alias!r} maps to both {existing!r} and {term.canonical!r}"
                    )
                index[alias] = term.canonical
        return self

    def content_dict(self) -> dict[str, Any]:
        """The identity-bearing payload: dimension + (canonical, aliases) only.

        Terms and aliases are sorted so the id is independent of declaration
        order; per-term ``meta`` and the vocabulary's provenance fields are
        excluded so enrichment never changes identity.
        """

        return {
            "dimension": self.dimension,
            "terms": [
                {"canonical": t.canonical, "aliases": sorted(t.aliases)}
                for t in sorted(self.terms, key=lambda t: t.canonical)
            ],
        }

    @computed_field  # type: ignore[prop-decorator]
    @property
    def id(self) -> str:
        return hash_obj(self.content_dict())

    def canonical_set(self) -> set[str]:
        return {t.canonical for t in self.terms}

    def alias_index(self) -> dict[str, str]:
        """Map every alias to its canonical (self-aliases excluded)."""

        index: dict[str, str] = {}
        for term in self.terms:
            for alias in term.aliases:
                if alias != term.canonical:
                    index[alias] = term.canonical
        return index

    def normalize(self, value: str) -> str | None:
        """Resolve a raw value to its canonical, or ``None`` if unknown.

        A value that is already canonical maps to itself.
        """

        if value in self.canonical_set():
            return value
        return self.alias_index().get(value)


def _dimension_keys(dimension: str) -> tuple[str, str]:
    try:
        return _DIMENSION_KEYS[dimension]
    except KeyError:
        raise ValueError(
            f"unknown vocabulary dimension: {dimension!r} (expected one of {sorted(_DIMENSION_KEYS)})"
        ) from None


def _assistant_payload(sample: Sample) -> dict[str, Any] | None:
    """The parsed JSON of an SFT sample's last assistant turn, if any."""

    if sample.kind != "sft":
        return None
    for message in reversed(sample.messages):
        if message.role == "assistant" and message.content:
            try:
                obj = json.loads(message.content)
            except (json.JSONDecodeError, ValueError):
                return None
            return obj if isinstance(obj, dict) else None
    return None


def derive_vocabulary(
    samples: Iterable[Sample], dimension: Dimension, name: str | None = None
) -> Vocabulary:
    """Bootstrap a draft vocabulary from a dataset's existing labels.

    Groups ``std_*`` values as canonicals and collects the distinct ``raw_*``
    values that differ from their ``std_*`` as aliases. Per-term counts land in
    ``term.meta`` as ``{"count": N, "alias_counts": {alias: n}}``.

    Real labels are noisy and the result must satisfy the one-canonical-per-alias
    invariant, so conflicts are resolved deterministically (the derive builder is
    the *only* path that auto-resolves; direct construction and curation stay
    strict):

    * A raw form labelled against several canonicals is assigned to the one it
      co-occurs with most often (ties broken by the lexicographically smaller
      canonical); it is never added to the losing canonicals.
    * A raw form that is itself a canonical stays its own canonical and is never
      registered as another term's alias.
    * Every dropped/conflicting mapping is recorded under the winning term's
      ``meta["alias_conflicts"]`` so a curator can review it.

    The output is therefore always a structurally valid *draft*.
    """

    raw_key, std_key = _dimension_keys(dimension)
    canonical_counts: Counter[str] = Counter()
    # raw alias -> {canonical: how many rows mapped this raw to that canonical}
    seen: dict[str, dict[str, int]] = defaultdict(dict)

    for sample in samples:
        payload = _assistant_payload(sample)
        if payload is None:
            continue
        std = payload.get(std_key)
        if not std or not isinstance(std, str):
            continue
        canonical_counts[std] += 1
        raw = payload.get(raw_key)
        if isinstance(raw, str) and raw and raw != std:
            seen[raw][std] = seen[raw].get(std, 0) + 1

    aliases_of: dict[str, dict[str, int]] = defaultdict(dict)  # canonical -> {alias: count}
    conflicts_of: dict[str, dict[str, Any]] = defaultdict(dict)  # canonical -> {alias: detail}

    for raw in sorted(seen):
        candidates = seen[raw]  # {canonical: count}
        if raw in canonical_counts:
            # The raw form is itself a canonical: it keeps its own identity and
            # the cross-mappings are dropped, but recorded for the curator.
            conflicts_of[raw][raw] = {
                "chosen": raw,
                "also_seen": sorted(candidates),
                "counts": dict(sorted(candidates.items())),
            }
            continue
        winner = min(candidates, key=lambda c: (-candidates[c], c))
        aliases_of[winner][raw] = candidates[winner]
        if len(candidates) > 1:
            conflicts_of[winner][raw] = {
                "chosen": winner,
                "also_seen": sorted(c for c in candidates if c != winner),
                "counts": dict(sorted(candidates.items())),
            }

    terms = []
    for canonical in sorted(canonical_counts):
        owned = aliases_of.get(canonical, {})
        meta: dict[str, Any] = {
            "count": canonical_counts[canonical],
            "alias_counts": dict(sorted(owned.items())),
        }
        if canonical in conflicts_of:
            meta["alias_conflicts"] = dict(sorted(conflicts_of[canonical].items()))
        terms.append(Term(canonical=canonical, aliases=sorted(owned), meta=meta))

    return Vocabulary(name=name, dimension=dimension, terms=terms, meta={"derived": True})


def normalize_samples(samples: Iterable[Sample], vocab: Vocabulary) -> list[Sample]:
    """Rewrite each sample's ``std_*`` to the canonical of its ``raw_*``.

    Values with no mapping are left unchanged (never dropped). Samples whose
    label is already canonical, or that carry no parseable payload, pass through
    untouched so their identity is preserved.
    """

    raw_key, std_key = _dimension_keys(vocab.dimension)
    index = vocab.alias_index()
    canonical = vocab.canonical_set()

    out: list[Sample] = []
    for sample in samples:
        if sample.kind != "sft":
            out.append(sample)
            continue

        changed = False
        messages = []
        for message in sample.messages:
            if message.role == "assistant" and message.content:
                try:
                    obj = json.loads(message.content)
                except (json.JSONDecodeError, ValueError):
                    obj = None
                if isinstance(obj, dict) and raw_key in obj:
                    raw = obj.get(raw_key)
                    mapped = raw if raw in canonical else index.get(raw) if isinstance(raw, str) else None
                    if mapped is not None and obj.get(std_key) != mapped:
                        obj[std_key] = mapped
                        message = message.model_copy(
                            update={"content": json.dumps(obj, ensure_ascii=False, sort_keys=True)}
                        )
                        changed = True
            messages.append(message)

        out.append(sample.model_copy(update={"messages": messages}) if changed else sample)
    return out


def validate_samples(
    samples: Iterable[Sample], vocab: Vocabulary
) -> tuple[list[Sample], dict[str, Any]]:
    """Flag samples whose ``std_*`` is not a known canonical.

    Appends a boolean ``vocab_<dimension>_valid`` signal to each checked sample
    without overwriting any existing signal keys, and returns a summary of how
    many were checked and which values were off-vocabulary.
    """

    _, std_key = _dimension_keys(vocab.dimension)
    canonical = vocab.canonical_set()
    signal_key = f"vocab_{vocab.dimension}_valid"

    out: list[Sample] = []
    checked = 0
    offending: Counter[str] = Counter()
    for sample in samples:
        payload = _assistant_payload(sample)
        if payload is None or std_key not in payload:
            out.append(sample)
            continue
        std = payload.get(std_key)
        is_valid = std in canonical
        checked += 1
        if not is_valid and isinstance(std, str):
            offending[std] += 1
        out.append(sample.model_copy(update={"signals": {**sample.signals, signal_key: is_valid}}))

    summary = {
        "checked": checked,
        "invalid": sum(offending.values()),
        "offending_values": dict(offending),
    }
    return out, summary
