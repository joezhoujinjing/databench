"""databench - infrastructure for managing LLM post-training data.

Public API: a content-addressed, versioned dataset store with automatic
lineage and reproducible mixtures. Start from :class:`Workspace`.
"""

from __future__ import annotations

from .dataset import Dataset, Manifest
from .io import read_jsonl, record_to_sample, detect_kind
from .recipe import Recipe, RecipeSource
from .schema import (
    Candidate,
    Message,
    PreferenceSample,
    RLSample,
    Rollout,
    SFTSample,
    Sample,
    ToolCall,
    TrajectorySample,
    parse_sample,
)
from .transform import Transform, transform
from .vocabulary import (
    Extractor,
    Term,
    Vocabulary,
    derive_vocabulary,
    normalize_samples,
    validate_samples,
)
from .workspace import Workspace
from . import ops

__all__ = [
    "Workspace",
    "Dataset",
    "Manifest",
    "Recipe",
    "RecipeSource",
    "transform",
    "Transform",
    "ops",
    # vocabulary
    "Vocabulary",
    "Term",
    "Extractor",
    "derive_vocabulary",
    "normalize_samples",
    "validate_samples",
    # io
    "read_jsonl",
    "record_to_sample",
    "detect_kind",
    # schema
    "Sample",
    "SFTSample",
    "PreferenceSample",
    "RLSample",
    "TrajectorySample",
    "Message",
    "ToolCall",
    "Rollout",
    "Candidate",
    "parse_sample",
]

__version__ = "0.0.1"
