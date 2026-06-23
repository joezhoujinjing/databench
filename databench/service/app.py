"""FastAPI application factory.

Wires the routers together and installs error handlers that map databench's
plain exceptions onto HTTP status codes:

* :class:`KeyError`        -> 404 (dataset/version not found)
* :class:`pydantic.ValidationError` -> 422 (bad params/payload)
* :class:`ValueError`      -> 400 (unparseable input, undetectable kind, ...)
* :class:`TypeError`       -> 400 (e.g. params passed to a param-less transform)
"""

from __future__ import annotations

import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .. import __version__
from .deps import get_workspace, workspace_root
from .routers import datasets, lineage, recipes, refs, transforms

# Static allowlist (regex): local Vite dev server + Alibaba Cloud OSS Hong Kong,
# where the frontend is hosted. Extra exact origins can be added at runtime via
# the DATABENCH_CORS_ORIGINS env var (comma-separated) without a code change.
CORS_ORIGIN_REGEX = (
    r"^https?://(localhost|127\.0\.0\.1):5173$"
    r"|^https?://[^/]*\.oss-cn-hongkong\.aliyuncs\.com$"
)


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
    )

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok", "workspace_root": workspace_root(), "version": __version__}

    app.include_router(datasets.router)
    app.include_router(transforms.router)
    app.include_router(recipes.router)
    app.include_router(lineage.router)
    app.include_router(refs.router)

    _install_error_handlers(app)
    return app


def _install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ValidationError)
    async def _on_validation(_: Request, exc: ValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    @app.exception_handler(KeyError)
    async def _on_key(_: Request, exc: KeyError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc.args[0] if exc.args else exc)})

    @app.exception_handler(ValueError)
    async def _on_value(_: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(TypeError)
    async def _on_type(_: Request, exc: TypeError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})


app = create_app()
