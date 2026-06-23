"""Transform endpoints: list available ops and run them."""

from __future__ import annotations

from itertools import islice

from fastapi import APIRouter, Depends, HTTPException, Query

from databench import Manifest, Workspace

from ..deps import get_workspace
from ..meta import DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT
from ..registry import TRANSFORMS, get_transform
from ..schemas import TransformInfo, TransformRunRequest, TransformsPage

router = APIRouter(tags=["transforms"])


@router.get("/transforms", response_model=TransformsPage)
def list_transforms(
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
) -> TransformsPage:
    """Paginated list of built-in transforms and their (optional) parameter schemas."""

    all_transforms = sorted(TRANSFORMS.values(), key=lambda t: t.name)
    page = islice(all_transforms, offset, offset + limit)
    items = [
        TransformInfo(
            name=t.name,
            version=t.version,
            params_schema=t.params_model.model_json_schema() if t.params_model else None,
        )
        for t in page
    ]
    return TransformsPage(total=len(all_transforms), limit=limit, offset=offset, items=items)


@router.post("/transforms/{name}/run", response_model=Manifest)
def run_transform(
    name: str,
    req: TransformRunRequest,
    ws: Workspace = Depends(get_workspace),
) -> Manifest:
    """Run a transform over one or more input datasets (auto-cached + lineage)."""

    transform = get_transform(name)
    if transform is None:
        raise HTTPException(status_code=404, detail=f"unknown transform: {name}")
    out = ws.run(transform, *req.inputs, ref=req.ref, **req.params)
    return out.manifest
