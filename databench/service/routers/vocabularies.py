"""Vocabulary endpoints: list, get, derive a draft, and curate (new version).

The service stays thin: every operation delegates to the :class:`Workspace`
methods, which own derivation, content addressing and lineage. Responses use the
core :class:`~databench.vocabulary.Vocabulary` model directly so the HTTP
contract tracks the library type.
"""

from __future__ import annotations

from itertools import islice

from fastapi import APIRouter, Depends, Query

from databench import Workspace
from databench.vocabulary import Dimension, Vocabulary

from ..deps import get_workspace
from ..meta import DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT
from ..schemas import VocabulariesPage, VocabularyInfo

router = APIRouter(tags=["vocabularies"])


@router.get("/vocabularies", response_model=VocabulariesPage)
def list_vocabularies(
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    ws: Workspace = Depends(get_workspace),
) -> VocabulariesPage:
    """Paginated list of named vocabularies (latest version each)."""

    all_vocabs = ws.list_vocabularies()
    page = islice(all_vocabs, offset, offset + limit)
    items = [VocabularyInfo(**v) for v in page]
    return VocabulariesPage(total=len(all_vocabs), limit=limit, offset=offset, items=items)


@router.get("/vocabularies/{name}", response_model=Vocabulary)
def get_vocabulary(name: str, ws: Workspace = Depends(get_workspace)) -> Vocabulary:
    """Get a vocabulary by name (or content id). 404 if unknown."""

    return ws.get_vocabulary(name)


@router.post("/vocabularies/{name}:derive", response_model=Vocabulary)
def derive_vocabulary(
    name: str,
    dataset: str = Query(..., description="source dataset ref or version"),
    dimension: Dimension = Query(..., description="which controlled dimension to derive"),
    ws: Workspace = Depends(get_workspace),
) -> Vocabulary:
    """Derive a draft vocabulary from a dataset's labels, persist it, return it."""

    return ws.derive_vocabulary(dataset, dimension=dimension, name=name)


@router.put("/vocabularies/{name}", response_model=Vocabulary)
def put_vocabulary(
    name: str, body: Vocabulary, ws: Workspace = Depends(get_workspace)
) -> Vocabulary:
    """Accept a curated vocabulary as a new content-addressed version."""

    vocab = body.model_copy(update={"name": name})
    return ws.save_vocabulary(vocab)
