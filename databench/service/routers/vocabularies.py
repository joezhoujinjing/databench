"""Vocabulary endpoints: list, get, derive a draft, and curate (new version).

The service stays thin: every operation delegates to the :class:`Workspace`
methods, which own derivation, content addressing and lineage. Responses use the
core :class:`~databench.vocabulary.Vocabulary` model directly so the HTTP
contract tracks the library type.
"""

from __future__ import annotations

from itertools import islice

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from databench import Manifest, Workspace
from databench.vocabulary import Extractor, Vocabulary

from ..deps import get_workspace
from ..meta import DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT
from ..schemas import ValidateResponse, VocabulariesPage, VocabularyInfo

router = APIRouter(tags=["vocabularies"])

# Convenience extractors for the dataset shapes this deployment knows about.
# This is the *only* place dimension-specific payload knowledge lives, and it is
# pure data at the edge - the core library stays agnostic. A request may always
# override by supplying its own extractor in the body.
_EXTRACTOR_PRESETS: dict[str, Extractor] = {
    "brand": Extractor(source="assistant_json", raw_key="raw_brand", std_key="std_brand"),
    "unit": Extractor(source="assistant_json", raw_key="raw_unit", std_key="std_unit"),
}


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
    dimension: str = Query(..., description="namespace label for the derived vocabulary"),
    extractor: Extractor | None = Body(
        default=None,
        description="how to pull (raw, std) labels; defaults to a server preset by dimension",
    ),
    ws: Workspace = Depends(get_workspace),
) -> Vocabulary:
    """Derive a draft vocabulary from a dataset's labels, persist it, return it.

    The extraction rule comes from the request body when provided, otherwise from
    a server-side preset keyed by ``dimension``. If neither resolves, 400.
    """

    ext = extractor or _EXTRACTOR_PRESETS.get(dimension)
    if ext is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"no extractor preset for dimension {dimension!r}; supply an "
                "extractor in the request body"
            ),
        )
    return ws.derive_vocabulary(dataset, dimension=dimension, extractor=ext, name=name)


@router.put("/vocabularies/{name}", response_model=Vocabulary)
def put_vocabulary(
    name: str, body: Vocabulary, ws: Workspace = Depends(get_workspace)
) -> Vocabulary:
    """Accept a curated vocabulary as a new content-addressed version."""

    vocab = body.model_copy(update={"name": name})
    return ws.save_vocabulary(vocab)


def _resolve_extractor(vocab: Vocabulary, override: Extractor | None) -> Extractor:
    """Pick the extractor to apply, most-specific first.

    1. an explicit override from the request body,
    2. the extractor the vocabulary recorded when it was derived,
    3. a server-side preset keyed by dimension.

    Raises 400 if none resolve. normalize/validate both need to read labels and
    normalize additionally writes them, so a structured :class:`Extractor` (not a
    bare callable) is required here.
    """

    ext = override or vocab.extractor() or _EXTRACTOR_PRESETS.get(vocab.dimension)
    if ext is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"no extractor for vocabulary {vocab.name or vocab.dimension!r}: it "
                "records none and no preset matches its dimension; supply one in the "
                "request body"
            ),
        )
    return ext


@router.post("/vocabularies/{name}:normalize", response_model=Manifest)
def normalize_vocabulary(
    name: str,
    dataset: str = Query(..., description="source dataset ref or version"),
    ref: str | None = Query(None, description="optional name for the produced dataset"),
    extractor: Extractor | None = Body(
        default=None,
        description="how to read/write labels; defaults to the vocab's own then a preset",
    ),
    ws: Workspace = Depends(get_workspace),
) -> Manifest:
    """Rewrite each sample's standard label to the vocab's canonical.

    Produces a new content-addressed dataset (with lineage) and returns its
    manifest. 404 if the vocabulary is unknown; 400 if no extractor resolves.
    """

    vocab = ws.get_vocabulary(name)
    ext = _resolve_extractor(vocab, extractor)
    out = ws.normalize_vocabulary(dataset, vocab, extractor=ext, ref=ref)
    return out.manifest


@router.post("/vocabularies/{name}:validate", response_model=ValidateResponse)
def validate_vocabulary(
    name: str,
    dataset: str = Query(..., description="source dataset ref or version"),
    ref: str | None = Query(None, description="optional name for the annotated dataset"),
    extractor: Extractor | None = Body(
        default=None,
        description="how to read labels; defaults to the vocab's own then a preset",
    ),
    ws: Workspace = Depends(get_workspace),
) -> ValidateResponse:
    """Flag samples whose standard label is off-vocabulary.

    Persists a dataset annotated with a ``vocab_<dimension>_valid`` per-sample
    signal (with lineage) and returns the summary alongside its manifest. 404 if
    the vocabulary is unknown; 400 if no extractor resolves.
    """

    vocab = ws.get_vocabulary(name)
    ext = _resolve_extractor(vocab, extractor)
    out, summary = ws.validate_vocabulary(dataset, vocab, extractor=ext, ref=ref)
    return ValidateResponse(summary=summary, dataset=out.manifest)
