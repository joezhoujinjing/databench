"""Recipe endpoint: materialize a reproducible training mixture."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from databench import Manifest, Workspace

from ..deps import get_workspace
from ..schemas import MaterializeRequest

router = APIRouter(tags=["recipes"])


@router.post("/recipes:materialize", response_model=Manifest)
def materialize_recipe(req: MaterializeRequest, ws: Workspace = Depends(get_workspace)) -> Manifest:
    """Resolve a recipe's sources and produce a single mixed dataset."""

    out = ws.materialize(req.recipe, ref=req.ref)
    return out.manifest
