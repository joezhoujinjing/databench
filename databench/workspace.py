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
from .recipe import Recipe, RecipeSource, mix
from .schema import Sample
from .store import LocalBlobStore
from .transform import Transform

DatasetLike = Union[Dataset, str]


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
