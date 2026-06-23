"""Code provenance for transforms.

A transform's ``op_version`` should change exactly when its behaviour changes, so
that editing a transform invalidates its cache and produces a new lineage edge.
We derive it from the function's own source text (a content hash) rather than a
hand-maintained number.

We also best-effort capture the git commit of the repo the transform is defined
in, as a *human-readable* provenance annotation. It is never part of the cache
key, and git is never a hard dependency: if git is absent or the code isn't in a
repo, capture simply returns ``None``.

Caveat: source hashing covers the function body only, not helper functions or
module-level constants it references. Restructure a shared helper and you may
want to bump a transform explicitly. This is a deliberate simplicity trade-off.
"""

from __future__ import annotations

import inspect
import os
import subprocess
import textwrap
from typing import Callable, Optional

from .hashing import hash_text


def code_version(fn: Callable[..., object]) -> str:
    """Content hash of a function's source, used as its op_version."""

    try:
        source = textwrap.dedent(inspect.getsource(fn))
    except (OSError, TypeError):
        # e.g. defined in a REPL/notebook where source isn't retrievable.
        source = f"{fn.__module__}.{getattr(fn, '__qualname__', fn.__name__)}"
    return "code:" + hash_text(source)[:16]


def source_dir(fn: Callable[..., object]) -> Optional[str]:
    try:
        path = inspect.getsourcefile(fn)
    except TypeError:
        return None
    return os.path.dirname(path) if path else None


def git_sha(path: Optional[str] = None) -> Optional[str]:
    """Best-effort short git SHA of ``path``'s repo, with a ``+dirty`` marker.

    Returns ``None`` if git is unavailable or the path is not in a repo. Never
    raises; never required.
    """

    cwd = path or os.getcwd()
    if not os.path.isdir(cwd):
        return None
    try:
        head = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if head.returncode != 0:
            return None
        sha = head.stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if status.returncode == 0 and status.stdout.strip():
            sha += "+dirty"
        return sha
    except (OSError, subprocess.SubprocessError):
        return None
