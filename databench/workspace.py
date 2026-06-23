"""The Workspace: the single user-facing handle.

A Workspace ties together a content-addressed store (data plane) and a catalog
(control plane) rooted at a directory. It is the only place that executes
transforms, so it is also the only place that records lineage - by construction
you cannot materialise a dataset without leaving a provenance trail.

Typical flow::

    ws = Workspace.open("./bench")
    raw = ws.add_samples(samples, name="raw")
    clean = ws.run(dedup, raw, ref="clean")
    ws.lineage("clean")                 # -> provenance DAG
    mixed = ws.materialize(recipe)      # reproducible training mixture
    ws.export(mixed, "train.jsonl")
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable, Optional, Union

import polars as pl

from .catalog import SQLiteCatalog
from .dataset import Dataset
from .hashing import hash_obj
from .io import read_jsonl
from .recipe import Recipe, RecipeSource, mix
from .schema import Kind, Sample
from .store import LocalBlobStore
from .transform import Transform
from .vocabulary import (
    Dimension,
    Vocabulary,
    derive_vocabulary as _derive_vocabulary,
    normalize_samples,
    validate_samples,
)

DatasetLike = Union[Dataset, str]
VocabularyLike = Union[Vocabulary, str]

# Op version for vocabulary lineage rows (mirrors a Transform's code version).
VOCAB_OP_VERSION = "1"


class Workspace:
    def __init__(self, root: str | os.PathLike[str], store: LocalBlobStore, catalog: SQLiteCatalog):
        self.root = Path(root)
        self.store = store
        self.catalog = catalog

    @classmethod
    def open(cls, root: str | os.PathLike[str]) -> "Workspace":
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        store = LocalBlobStore(root / "store")
        catalog = SQLiteCatalog(str(root / "catalog.db"))
        return cls(root, store, catalog)

    # -- ingest / fetch ------------------------------------------------------

    def add_samples(
        self, samples: Iterable[Sample], name: Optional[str] = None, message: Optional[str] = None
    ) -> Dataset:
        ds = Dataset.from_samples(samples, name=name)
        self._persist(ds)
        if name:
            self.catalog.set_ref(name, ds.version, message)
        return ds

    def add_jsonl(
        self,
        path: str | os.PathLike[str],
        name: Optional[str] = None,
        kind: Optional[Kind] = None,
        source: Optional[str] = None,
        message: Optional[str] = None,
    ) -> Dataset:
        """Ingest a JSONL file as a new dataset (kind auto-detected per line)."""

        samples = list(read_jsonl(path, kind=kind, source=source))
        return self.add_samples(samples, name=name, message=message)

    def add(self, ds: Dataset, name: Optional[str] = None, message: Optional[str] = None) -> Dataset:
        self._persist(ds)
        if name:
            self.catalog.set_ref(name, ds.version, message)
        return ds

    def get(self, ref_or_version: DatasetLike) -> Dataset:
        if isinstance(ref_or_version, Dataset):
            return ref_or_version
        version = self.catalog.resolve(ref_or_version)
        return self.store.read(version)

    # -- transforms ----------------------------------------------------------

    def run(self, transform: Transform, *inputs: DatasetLike, ref: Optional[str] = None, **params: Any) -> Dataset:
        input_ds = [self.get(i) for i in inputs]
        params_obj, params_dict = transform.build_params(params)

        cache_key = hash_obj(
            {
                "op": transform.name,
                "op_version": transform.version,
                "inputs": [d.version for d in input_ds],
                "params": params_dict,
            }
        )

        cached = self.catalog.find_run(cache_key)
        if cached and self.store.exists(cached):
            out = self.store.read(cached)
        else:
            result = transform.fn(*input_ds, params_obj) if params_obj is not None else transform.fn(*input_ds)
            out = _coerce(result, name=ref)
            self._persist(out)
            self.catalog.record_run(
                cache_key,
                transform.name,
                transform.version,
                params_dict,
                [d.version for d in input_ds],
                out.version,
            )

        if ref:
            self.catalog.set_ref(ref, out.version)
        return out

    # -- recipes -------------------------------------------------------------

    def materialize(self, recipe: Recipe, ref: Optional[str] = None) -> Dataset:
        resolved = {src.dataset: self.catalog.resolve(src.dataset) for src in recipe.sources}
        frames = [(src, self.get(resolved[src.dataset]).polars()) for src in recipe.sources]

        fingerprint = recipe.fingerprint(resolved)
        cache_key = hash_obj({"op": f"recipe:{recipe.name}", "fingerprint": fingerprint})

        cached = self.catalog.find_run(cache_key)
        if cached and self.store.exists(cached):
            out = self.store.read(cached)
        else:
            out = mix(recipe, frames)
            self._persist(out)
            self.catalog.record_run(
                cache_key,
                f"recipe:{recipe.name}",
                "1",
                recipe.model_dump(mode="json"),
                sorted(set(resolved.values())),
                out.version,
            )

        if ref:
            self.catalog.set_ref(ref, out.version)
        return out

    # -- vocabularies --------------------------------------------------------

    def derive_vocabulary(
        self, dataset: DatasetLike, dimension: Dimension, name: Optional[str] = None
    ) -> Vocabulary:
        """Bootstrap a draft vocabulary from a dataset's labels (cached + lineage).

        ``name`` doubles as the human-friendly ref pointing at the derived id.
        """

        ds = self.get(dataset)
        cache_key = hash_obj(
            {
                "op": "vocabulary:derive",
                "op_version": VOCAB_OP_VERSION,
                "inputs": [ds.version],
                "params": {"dimension": dimension},
            }
        )

        cached = self.catalog.find_run(cache_key)
        if cached and self.store.vocabulary_exists(cached):
            vocab = self.store.read_vocabulary(cached)
        else:
            vocab = _derive_vocabulary(ds.to_samples(), dimension=dimension, name=name)
            self._persist_vocabulary(vocab)
            self.catalog.record_run(
                cache_key,
                "vocabulary:derive",
                VOCAB_OP_VERSION,
                {"dimension": dimension},
                [ds.version],
                vocab.id,
            )

        if name:
            # name is not part of identity; reflect the requested ref on the
            # returned object even on a cache hit.
            vocab = vocab.model_copy(update={"name": name})
            self.catalog.set_vocab_ref(name, vocab.id)
        return vocab

    def save_vocabulary(self, vocab: Vocabulary) -> Vocabulary:
        """Persist a (curated) vocabulary as a new content-addressed version.

        If a vocabulary already exists under the same name, a ``curate`` lineage
        edge is recorded from the previous version to this one.
        """

        parent = self.catalog.get_vocab_ref(vocab.name) if vocab.name else None
        self._persist_vocabulary(vocab)
        if parent and parent != vocab.id:
            cache_key = hash_obj(
                {
                    "op": "vocabulary:curate",
                    "op_version": VOCAB_OP_VERSION,
                    "inputs": [parent],
                    "params": {},
                }
            )
            self.catalog.record_run(
                cache_key, "vocabulary:curate", VOCAB_OP_VERSION, {}, [parent], vocab.id
            )
        if vocab.name:
            self.catalog.set_vocab_ref(vocab.name, vocab.id)
        return vocab

    def get_vocabulary(self, name_or_id: str) -> Vocabulary:
        vid = self.catalog.get_vocab_ref(name_or_id) or name_or_id
        if not self.store.vocabulary_exists(vid):
            raise KeyError(f"vocabulary not found: {name_or_id}")
        return self.store.read_vocabulary(vid)

    def list_vocabularies(self) -> list[dict[str, Any]]:
        return self.catalog.list_vocabularies()

    def normalize_vocabulary(
        self, dataset: DatasetLike, vocab: VocabularyLike, ref: Optional[str] = None
    ) -> Dataset:
        """Map ``raw_*`` -> canonical over a dataset, writing a new dataset."""

        ds = self.get(dataset)
        v = vocab if isinstance(vocab, Vocabulary) else self.get_vocabulary(vocab)
        cache_key = hash_obj(
            {
                "op": "vocabulary:normalize",
                "op_version": VOCAB_OP_VERSION,
                "inputs": [ds.version, v.id],
                "params": {"dimension": v.dimension},
            }
        )

        cached = self.catalog.find_run(cache_key)
        if cached and self.store.exists(cached):
            out = self.store.read(cached)
        else:
            out = Dataset.from_samples(normalize_samples(ds.to_samples(), v), name=ref or ds.name)
            self._persist(out)
            self.catalog.record_run(
                cache_key,
                "vocabulary:normalize",
                VOCAB_OP_VERSION,
                {"dimension": v.dimension},
                [ds.version, v.id],
                out.version,
            )

        if ref:
            self.catalog.set_ref(ref, out.version)
        return out

    def validate_vocabulary(
        self, dataset: DatasetLike, vocab: VocabularyLike, ref: Optional[str] = None
    ) -> tuple[Dataset, dict[str, Any]]:
        """Flag off-vocabulary ``std_*`` values; returns (dataset, summary)."""

        ds = self.get(dataset)
        v = vocab if isinstance(vocab, Vocabulary) else self.get_vocabulary(vocab)
        samples, summary = validate_samples(ds.to_samples(), v)
        out = Dataset.from_samples(samples, name=ref or ds.name)
        self._persist(out)
        cache_key = hash_obj(
            {
                "op": "vocabulary:validate",
                "op_version": VOCAB_OP_VERSION,
                "inputs": [ds.version, v.id],
                "params": {"dimension": v.dimension},
            }
        )
        self.catalog.record_run(
            cache_key,
            "vocabulary:validate",
            VOCAB_OP_VERSION,
            {"dimension": v.dimension},
            [ds.version, v.id],
            out.version,
        )
        if ref:
            self.catalog.set_ref(ref, out.version)
        return out, summary

    # -- lineage -------------------------------------------------------------

    def lineage(self, ref_or_version: DatasetLike) -> dict[str, Any]:
        """Walk the provenance DAG upward from a dataset version."""

        version = ref_or_version.version if isinstance(ref_or_version, Dataset) else self.catalog.resolve(ref_or_version)
        return self._lineage(version, seen=set())

    def _lineage(self, version: str, seen: set[str]) -> dict[str, Any]:
        node: dict[str, Any] = {"version": version}
        meta = self.catalog.get_dataset(version)
        if meta:
            node["name"] = meta["name"]
            node["num_rows"] = meta["num_rows"]
        if version in seen:
            node["cycle"] = True
            return node
        seen = seen | {version}

        producers = self.catalog.runs_producing(version)
        if producers:
            run = producers[0]  # content-addressed: one producer is canonical
            node["produced_by"] = {
                "op": run["op"],
                "op_version": run["op_version"],
                "params": run["params"],
            }
            node["inputs"] = [self._lineage(v, seen) for v in run["inputs"]]
        return node

    # -- export --------------------------------------------------------------

    def export(self, ds: DatasetLike, path: str | os.PathLike[str], fmt: str = "messages-jsonl") -> Path:
        dataset = self.get(ds)
        path = Path(path)
        with path.open("w", encoding="utf-8") as fh:
            for sample in dataset.to_samples():
                fh.write(json.dumps(_export_record(sample, fmt), ensure_ascii=False) + "\n")
        return path

    # -- internals -----------------------------------------------------------

    def _persist(self, ds: Dataset) -> None:
        self.store.write(ds)
        self.catalog.register_dataset(ds.version, ds.manifest.name, len(ds), ds.manifest.kinds)

    def _persist_vocabulary(self, vocab: Vocabulary) -> None:
        self.store.write_vocabulary(vocab)
        self.catalog.register_vocabulary(vocab.id, vocab.name, vocab.dimension, len(vocab.terms))


def _coerce(result: Any, name: Optional[str]) -> Dataset:
    if isinstance(result, Dataset):
        return result
    if isinstance(result, pl.DataFrame):
        return Dataset.from_frame(result, name=name)
    raise TypeError(f"transform must return Dataset or polars.DataFrame, got {type(result)!r}")


def _export_record(sample: Sample, fmt: str) -> dict[str, Any]:
    kind = sample.kind
    if kind in ("sft", "trajectory"):
        return {"messages": [m.model_dump(exclude_none=True) for m in sample.messages]}
    if kind == "preference":
        return sample.model_dump(mode="json", include={"prompt", "chosen", "rejected"}, exclude_none=True)
    if kind == "rl":
        return sample.model_dump(mode="json", include={"prompt", "answer", "verifier", "rollouts"}, exclude_none=True)
    return sample.model_dump(mode="json", exclude_none=True)
