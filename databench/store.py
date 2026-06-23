"""Content-addressed blob store (the data plane).

Dataset rows live here as Parquet files keyed by their content version, with a
sibling manifest. The store is deliberately dumb: write-once, addressed by hash,
no mutation. This is the layer we keep pluggable - ``LocalBlobStore`` is the
filesystem implementation; an S3/fsspec backend can implement the same surface
later without touching the catalog or transform engine.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import polars as pl

from .dataset import Dataset, Manifest
from .vocabulary import Vocabulary


class LocalBlobStore:
    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        (self.root / "objects").mkdir(parents=True, exist_ok=True)
        (self.root / "vocabularies").mkdir(parents=True, exist_ok=True)

    def _dir(self, version: str) -> Path:
        return self.root / "objects" / version[:2]

    def _parquet(self, version: str) -> Path:
        return self._dir(version) / f"{version}.parquet"

    def _manifest(self, version: str) -> Path:
        return self._dir(version) / f"{version}.manifest.json"

    def exists(self, version: str) -> bool:
        return self._parquet(version).exists() and self._manifest(version).exists()

    def write(self, ds: Dataset) -> str:
        """Persist a dataset. Idempotent: identical content is a no-op."""

        version = ds.version
        if self.exists(version):
            return version

        self._dir(version).mkdir(parents=True, exist_ok=True)
        # Write to temp paths then atomically rename, so a crash never leaves a
        # half-written object that looks present.
        pq_tmp = self._parquet(version).with_suffix(".parquet.tmp")
        ds.polars().write_parquet(pq_tmp)
        os.replace(pq_tmp, self._parquet(version))

        man_tmp = self._manifest(version).with_suffix(".json.tmp")
        man_tmp.write_text(ds.manifest.model_dump_json(indent=2))
        os.replace(man_tmp, self._manifest(version))
        return version

    def read(self, version: str) -> Dataset:
        if not self.exists(version):
            raise KeyError(f"dataset version not found in store: {version}")
        frame = pl.read_parquet(self._parquet(version))
        manifest = Manifest.model_validate_json(self._manifest(version).read_text())
        return Dataset(frame, manifest)

    # -- vocabularies --------------------------------------------------------
    # Vocabularies are small structured documents, so they are stored as JSON
    # keyed by content id - same write-once, hash-addressed contract as datasets.

    def _vocab_dir(self, vid: str) -> Path:
        return self.root / "vocabularies" / vid[:2]

    def _vocab_path(self, vid: str) -> Path:
        return self._vocab_dir(vid) / f"{vid}.json"

    def vocabulary_exists(self, vid: str) -> bool:
        return self._vocab_path(vid).exists()

    def write_vocabulary(self, vocab: Vocabulary) -> str:
        """Persist a vocabulary. Idempotent: identical content is a no-op."""

        vid = vocab.id
        if self.vocabulary_exists(vid):
            return vid
        self._vocab_dir(vid).mkdir(parents=True, exist_ok=True)
        tmp = self._vocab_path(vid).with_suffix(".json.tmp")
        tmp.write_text(vocab.model_dump_json(indent=2), encoding="utf-8")
        os.replace(tmp, self._vocab_path(vid))
        return vid

    def read_vocabulary(self, vid: str) -> Vocabulary:
        if not self.vocabulary_exists(vid):
            raise KeyError(f"vocabulary not found in store: {vid}")
        return Vocabulary.model_validate_json(self._vocab_path(vid).read_text(encoding="utf-8"))
