"""databench - infrastructure for managing LLM post-training data.

Public API: a content-addressed, versioned dataset store with automatic
lineage and reproducible mixtures. Start from :class:`Workspace`.
"""

from __future__ import annotations

from .dataset import Dataset, Manifest
from .io import read_jsonl, record_to_sample, detect_kind
from .provenance import code_version, git_sha
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
from .transform import Transform, transform, generator
from .llm import LLM, TestLLM
from .workspace import Workspace
from . import ops, gen

__all__ = [
    "Workspace",
    "Dataset",
    "Manifest",
    "Recipe",
    "RecipeSource",
    "transform",
    "Transform",
    "generator",
    "ops",
    # synthesis
    "gen",
    "LLM",
    "TestLLM",
    # io
    "read_jsonl",
    "record_to_sample",
    "detect_kind",
    # provenance
    "code_version",
    "git_sha",
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
