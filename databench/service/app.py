"""FastAPI application factory.

Wires the routers together under the ``/v1`` contract prefix, exposes the
unversioned handshake surface (``/health``, ``/version``, ``/capabilities``),
and installs the unified error envelope (see :mod:`.errors`).
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .. import __version__
from .deps import workspace_root
from .errors import install_error_handlers
from .meta import API_VERSION, Capabilities, VersionInfo, capabilities, version_info
from .routers import datasets, lineage, recipes, refs, transforms, vocabularies

# Domain routes are served under this prefix; within a version, changes are
# additive only. Handshake/meta routes stay unversioned at root.
V1_PREFIX = f"/{API_VERSION}"

# Static allowlist (regex): local Vite dev server only. The production frontend is
# served from a single fixed origin (https://databench.jinjing.me); it is set at
# runtime via DATABENCH_CORS_ORIGINS as an exact match, never hardcoded or
# wildcarded here. Example:
#   DATABENCH_CORS_ORIGINS="https://databench.jinjing.me"
CORS_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1):5173$"


def cors_origins() -> list[str]:
    raw = os.environ.get("DATABENCH_CORS_ORIGINS", "")
    return [o.strip() for o in raw.split(",") if o.strip()]


def create_app() -> FastAPI:
    app = FastAPI(
        title="databench service",
        version=__version__,
        description="HTTP surface over a databench Workspace: ingest, transform, "
        "recipe, lineage and export for LLM post-training data.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins(),
        allow_origin_regex=CORS_ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,  # no cookies; tokens go in headers
        # Chrome's Private Network Access: a public HTTPS page (databench.jinjing.me)
        # calling a loopback backend must get Access-Control-Allow-Private-Network:
        # true on the preflight. Starlette gates this and answers it for us.
        allow_private_network=True,
    )

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok", "workspace_root": workspace_root(), "version": __version__}

    @app.get("/version", tags=["meta"], response_model=VersionInfo)
    def version() -> VersionInfo:
        """API/service/schema versions the frontend pins against."""

        return version_info()

    @app.get("/capabilities", tags=["meta"], response_model=Capabilities)
    def get_capabilities() -> Capabilities:
        """Runtime feature flags for what this deployment actually has wired up."""

        return capabilities()

    for module in (datasets, transforms, recipes, lineage, refs, vocabularies):
        app.include_router(module.router, prefix=V1_PREFIX)

    install_error_handlers(app)
    return app


app = create_app()
