"""Shared dependencies for the service.

A single :class:`~databench.Workspace` is opened per ``DATABENCH_ROOT`` and
reused across requests. The Workspace's store (atomic write-once files) and
catalog (per-operation SQLite connections in WAL mode) are each safe to touch
from multiple threads/workers, so sharing one handle is fine.
"""

from __future__ import annotations

import os

from databench import Workspace

DEFAULT_ROOT = "./bench"

_workspaces: dict[str, Workspace] = {}


def workspace_root() -> str:
    return os.environ.get("DATABENCH_ROOT", DEFAULT_ROOT)


def get_workspace() -> Workspace:
    """FastAPI dependency yielding the shared Workspace for the configured root."""

    root = workspace_root()
    ws = _workspaces.get(root)
    if ws is None:
        ws = Workspace.open(root)
        _workspaces[root] = ws
    return ws
