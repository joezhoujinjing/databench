"""FastAPI service exposing databench's Workspace over HTTP.

The service is a thin translation layer: each endpoint maps onto a
:class:`databench.Workspace` method, reusing the existing schema, transforms,
recipes and lineage rather than reimplementing them. Import :func:`create_app`
to build the ASGI app::

    DATABENCH_ROOT=./bench uvicorn databench.service.app:app
"""

from __future__ import annotations

from .app import create_app

__all__ = ["create_app"]
