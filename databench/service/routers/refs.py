"""Ref endpoints: list named pointers and resolve one to a version."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from databench import Workspace

from ..deps import get_workspace

router = APIRouter(tags=["refs"])


@router.get("/refs")
def list_refs(ws: Workspace = Depends(get_workspace)) -> dict[str, str]:
    """All named refs mapped to their current dataset version."""

    return ws.catalog.list_refs()


@router.get("/refs/{name}")
def resolve_ref(name: str, ws: Workspace = Depends(get_workspace)) -> dict[str, str]:
    """Resolve a ref name to its concrete dataset version."""

    version = ws.catalog.get_ref(name)
    if version is None:
        raise HTTPException(status_code=404, detail=f"unknown ref: {name}")
    return {"name": name, "version": version}
