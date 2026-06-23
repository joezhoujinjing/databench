"""Service-level contract metadata: versioning, handshake and pagination caps.

These constants are the backend half of the cross-repo contract. The frontend
fetches ``/version`` and ``/capabilities`` on connect and tailors its UI to what
THIS deployment actually has wired up, so the feature flags are detected at
runtime rather than hardcoded.
"""

from __future__ import annotations

import importlib.util

from pydantic import BaseModel, Field

from .. import __version__

# URL/version surface. Domain routes live under ``/v1``; ``api_version`` mirrors
# that prefix so the frontend can assert it talks to a compatible major.
API_VERSION = "v1"

# Version of the data schema (the ``Sample`` union and its records). Bump this
# only on a breaking change to those shapes; additive fields keep it stable.
SCHEMA_VERSION = "1"

# Oldest frontend client this service still speaks to. Bump on a breaking
# contract change; the client compares its own version against this and refuses
# to start (or warns) if it is older.
MIN_CLIENT = "0.1.0"

# Pagination: a hard server-side cap so a client cannot dump an entire dataset
# through a list/sample endpoint. The sanctioned way to pull everything is the
# streaming NDJSON export at ``/v1/datasets/{ref}/export``.
MAX_PAGE_LIMIT = 500
DEFAULT_PAGE_LIMIT = 20


def _module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def detect_features() -> dict[str, bool]:
    """Per-deployed-module capability flags for the running service.

    Each flag answers "does this deployment actually have the module wired up?"
    so the frontend can show/hide the matching UI. Detection is by feature
    probe, never a hardcoded ``True``.
    """

    from databench import Workspace

    from .registry import TRANSFORMS

    return {
        "transforms": len(TRANSFORMS) > 0,
        "recipes": hasattr(Workspace, "materialize"),
        "lineage": hasattr(Workspace, "lineage"),
        "vocabularies": hasattr(Workspace, "derive_vocabulary"),
        "jsonl_ingest": hasattr(Workspace, "add_jsonl"),
        "export": hasattr(Workspace, "export"),
        # Optional modules not present in this deployment yet; probed so the flag
        # flips automatically once the package ships them.
        "synthesis": _module_available("databench.synthesis"),
        "annotation": _module_available("databench.annotation"),
    }


class VersionInfo(BaseModel):
    api_version: str = Field(description="major API version, mirrors the /v1 URL prefix")
    service_version: str = Field(description="databench package version (databench.__version__)")
    schema_version: str = Field(description="version of the Sample data schema")


class Capabilities(BaseModel):
    api_version: str
    min_client: str = Field(description="minimum compatible frontend client version")
    features: dict[str, bool] = Field(description="per-deployed-module feature flags")


def version_info() -> VersionInfo:
    return VersionInfo(
        api_version=API_VERSION,
        service_version=__version__,
        schema_version=SCHEMA_VERSION,
    )


def capabilities() -> Capabilities:
    return Capabilities(
        api_version=API_VERSION,
        min_client=MIN_CLIENT,
        features=detect_features(),
    )
