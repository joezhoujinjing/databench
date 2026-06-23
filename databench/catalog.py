"""The catalog (the control plane / brain).

A small, queryable metadata store that records:

* **datasets** - every known dataset version and its summary stats
* **runs**     - every transform execution: op, params, inputs -> output. These
  rows ARE the lineage graph and the transform cache (keyed by ``cache_key``).
* **refs**     - human-friendly names pointing at a version (git-tag style).

It is intentionally backed by stdlib ``sqlite3`` so local-first usage needs
zero services. The public surface is small enough that a Postgres
implementation can be dropped in behind the same methods later.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
    version    TEXT PRIMARY KEY,
    name       TEXT,
    num_rows   INTEGER NOT NULL,
    kinds_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    cache_key      TEXT PRIMARY KEY,
    op             TEXT NOT NULL,
    op_version     TEXT NOT NULL,
    params_json    TEXT NOT NULL,
    inputs_json    TEXT NOT NULL,
    output_version TEXT NOT NULL,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_output ON runs (output_version);
CREATE TABLE IF NOT EXISTS refs (
    name       TEXT PRIMARY KEY,
    version    TEXT NOT NULL,
    message    TEXT,
    updated_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SQLiteCatalog:
    def __init__(self, db_path: str):
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    # -- datasets ------------------------------------------------------------

    def register_dataset(self, version: str, name: Optional[str], num_rows: int, kinds: dict[str, int]) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO datasets (version, name, num_rows, kinds_json, created_at) VALUES (?,?,?,?,?)",
            (version, name, num_rows, json.dumps(kinds), _now()),
        )
        self._conn.commit()

    def get_dataset(self, version: str) -> Optional[dict[str, Any]]:
        row = self._conn.execute("SELECT * FROM datasets WHERE version = ?", (version,)).fetchone()
        return _row_to_dataset(row) if row else None

    # -- runs (lineage + cache) ---------------------------------------------

    def record_run(
        self,
        cache_key: str,
        op: str,
        op_version: str,
        params: dict[str, Any],
        inputs: list[str],
        output_version: str,
    ) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO runs (cache_key, op, op_version, params_json, inputs_json, output_version, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (cache_key, op, op_version, json.dumps(params), json.dumps(inputs), output_version, _now()),
        )
        self._conn.commit()

    def find_run(self, cache_key: str) -> Optional[str]:
        """Return the cached output version for a cache key, if any."""

        row = self._conn.execute("SELECT output_version FROM runs WHERE cache_key = ?", (cache_key,)).fetchone()
        return row["output_version"] if row else None

    def runs_producing(self, version: str) -> list[dict[str, Any]]:
        rows = self._conn.execute("SELECT * FROM runs WHERE output_version = ?", (version,)).fetchall()
        return [_row_to_run(r) for r in rows]

    # -- refs (named pointers) ----------------------------------------------

    def set_ref(self, name: str, version: str, message: Optional[str] = None) -> None:
        self._conn.execute(
            "INSERT INTO refs (name, version, message, updated_at) VALUES (?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET version=excluded.version, message=excluded.message, updated_at=excluded.updated_at",
            (name, version, message, _now()),
        )
        self._conn.commit()

    def get_ref(self, name: str) -> Optional[str]:
        row = self._conn.execute("SELECT version FROM refs WHERE name = ?", (name,)).fetchone()
        return row["version"] if row else None

    def list_refs(self) -> dict[str, str]:
        rows = self._conn.execute("SELECT name, version FROM refs ORDER BY name").fetchall()
        return {r["name"]: r["version"] for r in rows}

    def resolve(self, ref_or_version: str) -> str:
        """Resolve a name or version string to a concrete dataset version."""

        if self.get_dataset(ref_or_version) is not None:
            return ref_or_version
        ref = self.get_ref(ref_or_version)
        if ref is not None:
            return ref
        # Could still be a version not yet registered (e.g. ingested elsewhere).
        return ref_or_version


def _row_to_dataset(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "version": row["version"],
        "name": row["name"],
        "num_rows": row["num_rows"],
        "kinds": json.loads(row["kinds_json"]),
        "created_at": row["created_at"],
    }


def _row_to_run(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "cache_key": row["cache_key"],
        "op": row["op"],
        "op_version": row["op_version"],
        "params": json.loads(row["params_json"]),
        "inputs": json.loads(row["inputs_json"]),
        "output_version": row["output_version"],
        "created_at": row["created_at"],
    }
