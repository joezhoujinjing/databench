"""Controlled vocabularies: canonical terms with aliases.

A :class:`Vocabulary` is a content-addressed registry that maps many raw surface
forms onto a single canonical term within one *dimension*. It is the
controlled-vocabulary sibling of :class:`~databench.schema.Sample` and follows
the same two rules:

* **Content addressing** - ``Vocabulary.id`` hashes the *identity payload only*
  (the dimension plus each term's canonical + aliases). ``name``/``status``/
  ``meta``/``source`` and per-term ``meta`` are excluded, so renaming a
  vocabulary, flipping its lifecycle status, or annotating a term never changes
  its identity. Curating the terms does - a curated edit is simply a new
  content-addressed version.
* **One canonical per alias, disjoint from canonicals** - within a vocabulary
  every alias resolves to exactly one canonical, canonicals are unique, and no
  alias is itself a canonical of any term. Violations raise at construction time
  (a pydantic validation error), so a malformed vocabulary can never be
  persisted.

Vocabulary is *general infrastructure*: it is a namespace of canonical terms and
knows nothing about any particular dataset payload. ``dimension`` is an open
string (a namespace label, e.g. ``"brand"`` or ``"unit"``) supplied by the
caller as data, not enumerated in code.

The label-driven operations (:func:`derive_vocabulary`, :func:`normalize_samples`,
:func:`validate_samples`) bootstrap and apply a vocabulary over a dataset. *How*
to pull the ``(raw, std)`` label pair out of a sample is not baked in - it is an
:class:`Extractor` passed at call time. The only built-in extractor reads the
last assistant turn as JSON and pulls two caller-named keys; lib users may also
pass any ``Callable[[Sample], tuple[str | None, str | None]]`` for the read-only
paths (derive/validate).
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from typing import Any, Callable, Iterable, Literal, Union

from pydantic import BaseModel, Field, computed_field, model_validator

from .hashing import hash_obj
from .schema import Sample

Status = Literal["draft", "curated"]

# (raw, std) label pair pulled from a single sample; either side may be missing.
LabelPair = tuple[Union[str, None], Union[str, None]]
ExtractorFn = Callable[[Sample], LabelPair]


def _assistant_payload(sample: Sample) -> dict[str, Any] | None:
    """The parsed JSON of an SFT sample's last assistant turn, if any.

    This is the only generic shape the module knows about: an assistant message
    whose content is a JSON object. Which *keys* carry the labels is the
    caller's data (see :class:`Extractor`), not knowledge baked in here.
    """

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


class Extractor(BaseModel):
    """A declarative, serializable rule for pulling label pairs out of samples.

    ``source="assistant_json"`` parses the last assistant turn as a JSON object
    and reads ``raw_key`` / ``std_key`` from it. The keys are data, so the same
    generic extractor serves any dataset that labels with a raw/standard pair -
    nothing dataset-specific lives in the core type. Because it serializes, the
    exact extraction used by :func:`derive_vocabulary` can be recorded as
    provenance and replayed by normalize/validate.
    """

    source: Literal["assistant_json"] = "assistant_json"
    raw_key: str
    std_key: str

    def extract(self, sample: Sample) -> LabelPair:
        payload = _assistant_payload(sample)
        if payload is None:
            return (None, None)
        raw = payload.get(self.raw_key)
        std = payload.get(self.std_key)
        return (
            raw if isinstance(raw, str) and raw else None,
            std if isinstance(std, str) and std else None,
        )

    def write_std(self, sample: Sample, value: str) -> Sample:
        """Return a copy of ``sample`` with ``std_key`` set to ``value``.

        Rewrites the same last-assistant JSON object that :meth:`extract` reads.
        Samples with no parseable payload pass through unchanged.
        """

        target = None
        for idx in range(len(sample.messages) - 1, -1, -1):
            msg = sample.messages[idx]
            if msg.role == "assistant" and msg.content:
                try:
                    obj = json.loads(msg.content)
                except (json.JSONDecodeError, ValueError):
                    return sample
                if isinstance(obj, dict):
                    target = (idx, obj)
                break
        if target is None:
            return sample
        idx, obj = target
        if obj.get(self.std_key) == value:
            return sample
        obj[self.std_key] = value
        messages = list(sample.messages)
        messages[idx] = messages[idx].model_copy(
            update={"content": json.dumps(obj, ensure_ascii=False, sort_keys=True)}
        )
        return sample.model_copy(update={"messages": messages})


def _as_reader(extractor: Extractor | ExtractorFn) -> ExtractorFn:
    if isinstance(extractor, Extractor):
        return extractor.extract
    if callable(extractor):
        return extractor
    raise TypeError(
        f"extractor must be an Extractor or a callable, got {type(extractor)!r}"
    )


class Term(BaseModel):
    """One canonical term plus the raw forms that map onto it."""

    canonical: str
    aliases: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)


class Vocabulary(BaseModel):
    """A controlled, content-addressed registry of canonical terms."""

    name: str | None = None
    dimension: str
    status: Status = "curated"
    terms: list[Term] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)
    source: str | None = None

    @model_validator(mode="after")
    def _check_invariants(self) -> "Vocabulary":
        canonicals: set[str] = set()
        for term in self.terms:
            if term.canonical in canonicals:
                raise ValueError(f"duplicate canonical term: {term.canonical!r}")
            canonicals.add(term.canonical)

        index: dict[str, str] = {}
        for term in self.terms:
            for alias in term.aliases:
                if alias in canonicals:
                    raise ValueError(
                        f"alias {alias!r} is also a canonical term (aliases and "
                        "canonicals must be disjoint)"
                    )
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
        order; ``status``, per-term ``meta`` and the vocabulary's provenance
        fields are excluded so enrichment never changes identity.
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
        """Map every alias to its canonical."""

        index: dict[str, str] = {}
        for term in self.terms:
            for alias in term.aliases:
                index[alias] = term.canonical
        return index

    def normalize(self, value: str) -> str | None:
        """Resolve a raw value to its canonical, or ``None`` if unknown.

        A value that is already canonical maps to itself.
        """

        if value in self.canonical_set():
            return value
        return self.alias_index().get(value)

    def extractor(self) -> Extractor | None:
        """The extractor recorded as derive provenance, if any."""

        spec = self.meta.get("extractor")
        return Extractor.model_validate(spec) if isinstance(spec, dict) else None


def derive_vocabulary(
    samples: Iterable[Sample],
    dimension: str,
    extractor: Extractor | ExtractorFn,
    name: str | None = None,
) -> Vocabulary:
    """Bootstrap a draft vocabulary from a dataset's existing labels.

    ``extractor`` yields the ``(raw, std)`` label pair for each sample. Groups
    ``std`` values as canonicals and collects the distinct ``raw`` values that
    differ from their ``std`` as aliases. Per-term counts land in ``term.meta``
    as ``{"count": N, "alias_counts": {alias: n}}``.

    Real labels are noisy and the result must satisfy the invariants, so
    conflicts are resolved deterministically (derive is the *only* path that
    auto-resolves; direct construction and curation stay strict):

    * A raw form labelled against several canonicals is assigned to the one it
      co-occurs with most often (ties broken by the lexicographically smaller
      canonical); it is never added to the losing canonicals.
    * A raw form that is itself a canonical stays its own canonical and is never
      registered as another term's alias.
    * Every dropped/conflicting mapping is recorded under the winning term's
      ``meta["alias_conflicts"]`` so a curator can review it.

    The output is always a structurally valid *draft*. When ``extractor`` is an
    :class:`Extractor`, its spec is recorded in ``meta["extractor"]`` so the same
    extraction can be replayed by normalize/validate.
    """

    read = _as_reader(extractor)
    canonical_counts: Counter[str] = Counter()
    # raw alias -> {canonical: how many rows mapped this raw to that canonical}
    seen: dict[str, dict[str, int]] = defaultdict(dict)

    for sample in samples:
        raw, std = read(sample)
        if not std:
            continue
        canonical_counts[std] += 1
        if raw and raw != std:
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

    vocab_meta: dict[str, Any] = {"derived": True}
    if isinstance(extractor, Extractor):
        vocab_meta["extractor"] = extractor.model_dump()
    return Vocabulary(
        name=name, dimension=dimension, status="draft", terms=terms, meta=vocab_meta
    )


def normalize_samples(
    samples: Iterable[Sample], vocab: Vocabulary, extractor: Extractor
) -> list[Sample]:
    """Rewrite each sample's standard label to the canonical of its raw label.

    ``extractor`` reads the raw label and writes the resolved canonical back.
    Values with no mapping are left unchanged (never dropped). Samples whose
    label is already canonical, or that carry no parseable payload, pass through
    untouched so their identity is preserved.
    """

    out: list[Sample] = []
    for sample in samples:
        raw, std = extractor.extract(sample)
        if not raw:
            out.append(sample)
            continue
        mapped = vocab.normalize(raw)
        if mapped is not None and mapped != std:
            out.append(extractor.write_std(sample, mapped))
        else:
            out.append(sample)
    return out


def validate_samples(
    samples: Iterable[Sample], vocab: Vocabulary, extractor: Extractor | ExtractorFn
) -> tuple[list[Sample], dict[str, Any]]:
    """Flag samples whose standard label is not a known canonical.

    Appends a boolean ``vocab_<dimension>_valid`` signal to each checked sample
    without overwriting any existing signal keys, and returns a summary of how
    many were checked and which values were off-vocabulary.
    """

    read = _as_reader(extractor)
    canonical = vocab.canonical_set()
    signal_key = f"vocab_{vocab.dimension}_valid"

    out: list[Sample] = []
    checked = 0
    offending: Counter[str] = Counter()
    for sample in samples:
        _, std = read(sample)
        if std is None:
            out.append(sample)
            continue
        is_valid = std in canonical
        checked += 1
        if not is_valid:
            offending[std] += 1
        out.append(sample.model_copy(update={"signals": {**sample.signals, signal_key: is_valid}}))

    summary = {
        "checked": checked,
        "invalid": sum(offending.values()),
        "offending_values": dict(offending),
    }
    return out, summary
