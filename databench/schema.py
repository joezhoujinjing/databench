"""The unified post-training sample schema.

A :class:`Sample` is the atomic unit databench manages. We use a discriminated
union over the four post-training data forms so the payload is normalised and
typed, while ``meta`` and ``signals`` stay open for extension:

* ``sft``        - supervised multi-turn conversation (``messages``)
* ``preference`` - DPO/RLHF pair (``prompt`` + ``chosen``/``rejected``)
* ``rl``         - verifiable-reward sample (``prompt`` + ``rollouts``)
* ``trajectory`` - agent trace with tool calls/results (``messages``)

Design rules baked in here:

* **Content addressing** - ``Sample.id`` is a hash of the *content only*. The
  ``meta``/``signals``/``source`` fields are excluded, so enriching a sample
  (adding a signal) never changes its identity.
* **Non-destructive enrichment** - ``signals`` is an open dict that transforms
  append to; nothing is ever overwritten by the schema itself.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter

from .hashing import hash_obj

SCHEMA_VERSION = "1"

Kind = Literal["sft", "preference", "rl", "trajectory"]


class ToolCall(BaseModel):
    """A single tool invocation emitted by an assistant turn."""

    id: str | None = None
    name: str
    arguments: Any = None  # dict or raw JSON string, kept as-is


class Message(BaseModel):
    """One chat message. Shared by SFT and trajectory payloads."""

    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    name: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None


class Rollout(BaseModel):
    """One sampled completion for an RL prompt, with its reward."""

    text: str
    reward: float | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class Candidate(BaseModel):
    """A ranked completion, used when a preference sample has >2 options."""

    completion: Union[Message, list[Message]]
    rank: int | None = None
    score: float | None = None


class _SampleBase(BaseModel):
    # Fields that describe provenance/enrichment but are NOT part of identity.
    IDENTITY_EXCLUDE: ClassVar[set[str]] = {"source", "meta", "signals"}

    source: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)
    signals: dict[str, Any] = Field(default_factory=dict)

    def content_dict(self) -> dict[str, Any]:
        """The identity-bearing payload (kind + task fields), JSON-ready."""

        return self.model_dump(mode="json", exclude=self.IDENTITY_EXCLUDE)

    @property
    def id(self) -> str:
        return hash_obj(self.content_dict())


class SFTSample(_SampleBase):
    kind: Literal["sft"] = "sft"
    messages: list[Message]


class PreferenceSample(_SampleBase):
    kind: Literal["preference"] = "preference"
    prompt: list[Message] = Field(default_factory=list)
    chosen: Union[Message, list[Message]]
    rejected: Union[Message, list[Message]]
    candidates: list[Candidate] | None = None


class RLSample(_SampleBase):
    kind: Literal["rl"] = "rl"
    prompt: list[Message] = Field(default_factory=list)
    answer: str | None = None
    verifier: str | None = None
    rollouts: list[Rollout] = Field(default_factory=list)


class TrajectorySample(_SampleBase):
    kind: Literal["trajectory"] = "trajectory"
    messages: list[Message]


Sample = Annotated[
    Union[SFTSample, PreferenceSample, RLSample, TrajectorySample],
    Field(discriminator="kind"),
]

_ADAPTER: TypeAdapter[Sample] = TypeAdapter(Sample)


def parse_sample(obj: Any) -> Sample:
    """Validate a dict (or model) into the correct Sample subtype."""

    return _ADAPTER.validate_python(obj)
