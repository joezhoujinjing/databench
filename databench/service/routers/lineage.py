"""Lineage endpoint: walk the provenance DAG of a dataset."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from databench import Workspace

from ..deps import get_workspace

router = APIRouter(tags=["lineage"])


@router.get("/lineage/{ref}")
def get_lineage(ref: str, ws: Workspace = Depends(get_workspace)) -> dict[str, Any]:
    """Return the provenance DAG (what produced this dataset, recursively)."""

    return ws.lineage(ref)
