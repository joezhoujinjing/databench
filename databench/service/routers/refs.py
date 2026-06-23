"""Ref endpoints: list named pointers and resolve one to a version."""

from __future__ import annotations

from itertools import islice

from fastapi import APIRouter, Depends, HTTPException, Query

from databench import Workspace

from ..deps import get_workspace
from ..meta import DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT
from ..schemas import RefInfo, RefsPage

router = APIRouter(tags=["refs"])


@router.get("/refs", response_model=RefsPage)
def list_refs(
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    ws: Workspace = Depends(get_workspace),
) -> RefsPage:
    """Paginated list of named refs mapped to their current dataset version."""

    all_refs = sorted(ws.catalog.list_refs().items())
    page = islice(all_refs, offset, offset + limit)
    items = [RefInfo(name=name, version=version) for name, version in page]
    return RefsPage(total=len(all_refs), limit=limit, offset=offset, items=items)


@router.get("/refs/{name}", response_model=RefInfo)
def resolve_ref(name: str, ws: Workspace = Depends(get_workspace)) -> RefInfo:
    """Resolve a ref name to its concrete dataset version."""

    version = ws.catalog.get_ref(name)
    if version is None:
        raise HTTPException(status_code=404, detail=f"unknown ref: {name}")
    return RefInfo(name=name, version=version)
