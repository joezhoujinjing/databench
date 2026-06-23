"""Transform endpoints: list available ops and run them."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from databench import Manifest, Workspace

from ..deps import get_workspace
from ..registry import TRANSFORMS, get_transform
from ..schemas import TransformInfo, TransformRunRequest

router = APIRouter(tags=["transforms"])


@router.get("/transforms", response_model=list[TransformInfo])
def list_transforms() -> list[TransformInfo]:
    """List the built-in transforms and their (optional) parameter schemas."""

    return [
        TransformInfo(
            name=t.name,
            version=t.version,
            params_schema=t.params_model.model_json_schema() if t.params_model else None,
        )
        for t in TRANSFORMS.values()
    ]


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
