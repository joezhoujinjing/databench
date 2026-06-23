"""Dataset endpoints: ingest, inspect, preview, export."""

from __future__ import annotations

import json
import os
import tempfile
from itertools import islice
from typing import Optional

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import StreamingResponse

from databench import Manifest, Workspace
from databench.schema import Kind
from databench.workspace import _export_record

from ..deps import get_workspace
from ..schemas import IngestSamplesRequest, SamplesPage

router = APIRouter(tags=["datasets"])


@router.post("/datasets", response_model=Manifest)
def ingest_samples(req: IngestSamplesRequest, ws: Workspace = Depends(get_workspace)) -> Manifest:
    """Ingest a list of typed samples (JSON body) as a new dataset."""

    ds = ws.add_samples(req.samples, name=req.name, message=req.message)
    return ds.manifest


@router.post("/datasets:ingest-jsonl", response_model=Manifest)
async def ingest_jsonl(
    file: UploadFile = File(...),
    name: Optional[str] = Query(None),
    kind: Optional[Kind] = Query(None),
    source: Optional[str] = Query(None),
    ws: Workspace = Depends(get_workspace),
) -> Manifest:
    """Ingest an uploaded ``.jsonl`` file (kind auto-detected per line)."""

    payload = await file.read()
    tmp = tempfile.NamedTemporaryFile("wb", suffix=".jsonl", delete=False)
    try:
        tmp.write(payload)
        tmp.close()
        ds = ws.add_jsonl(tmp.name, name=name, kind=kind, source=source)
    finally:
        os.unlink(tmp.name)
    return ds.manifest


@router.get("/datasets/{ref}", response_model=Manifest)
def get_dataset(ref: str, ws: Workspace = Depends(get_workspace)) -> Manifest:
    """Return the manifest (version, name, row count, kind histogram) of a dataset."""

    return ws.get(ref).manifest


@router.get("/datasets/{ref}/samples", response_model=SamplesPage)
def preview_samples(
    ref: str,
    limit: int = Query(20, ge=1, le=500),
    offset: int = Query(0, ge=0),
    ws: Workspace = Depends(get_workspace),
) -> SamplesPage:
    """Paginated preview of a dataset's samples."""

    ds = ws.get(ref)
    items = list(islice(ds.to_samples(), offset, offset + limit))
    return SamplesPage(total=len(ds), limit=limit, offset=offset, items=items)


@router.get("/datasets/{ref}/export")
def export_dataset(
    ref: str,
    fmt: str = Query("messages-jsonl"),
    ws: Workspace = Depends(get_workspace),
) -> StreamingResponse:
    """Stream a dataset as training-ready JSONL."""

    ds = ws.get(ref)

    def lines():
        for sample in ds.to_samples():
            yield json.dumps(_export_record(sample, fmt), ensure_ascii=False) + "\n"

    filename = f"{ds.name or ds.version[:12]}.jsonl"
    return StreamingResponse(
        lines(),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
