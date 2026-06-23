"""Resolving where a workspace lives.

By default databench behaves as a single personal data hub at ``~/.databench``.
The location is resolved with this precedence:

1. an explicit ``root`` passed to :meth:`Workspace.open` (isolated workspace)
2. the ``$DATABENCH_HOME`` environment variable
3. the default ``~/.databench``

User (``~``) and environment-variable references are expanded in all cases.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_HOME = "~/.databench"
ENV_HOME = "DATABENCH_HOME"


def resolve_root(root: str | os.PathLike[str] | None = None) -> Path:
    if root is not None:
        raw = os.fspath(root)
    else:
        raw = os.environ.get(ENV_HOME) or DEFAULT_HOME
    expanded = os.path.expanduser(os.path.expandvars(raw))
    return Path(expanded).resolve()
