"""The LLM seam for synthetic-data transforms.

Generation transforms depend on this thin :class:`LLM` protocol, never on a
concrete provider. Any client (Anthropic, OpenAI, vLLM, distilabel, ...) can be
adapted by implementing ``id`` + ``generate``. The ``id`` is what enters a
generation transform's cache key, so switching model or settings produces a new,
distinct dataset version.

:class:`TestLLM` is a deterministic in-process implementation used by tests and
examples so the whole synthesis path runs fully offline.
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Protocol, runtime_checkable

from .schema import Message


@runtime_checkable
class LLM(Protocol):
    @property
    def id(self) -> str:
        """Stable identity (model + settings) folded into cache keys."""

    def generate(self, messages: list[Message], **options: Any) -> str:
        ...


def last_user_text(messages: list[Message]) -> str:
    for m in reversed(messages):
        if m.role == "user" and m.content:
            return m.content
    for m in reversed(messages):
        if m.content:
            return m.content
    return ""


class TestLLM:
    """A deterministic, offline LLM for tests and demos.

    By default it echoes a template over the last user turn. Pass ``fn`` for
    custom deterministic behaviour (e.g. returning a score for a judge).
    """

    def __init__(
        self,
        template: str = "Response to: {prompt}",
        fn: Optional[Callable[..., str]] = None,
        id: str = "echo",
    ):
        self._template = template
        self._fn = fn
        self._id = id

    @property
    def id(self) -> str:
        return f"test:{self._id}"

    def generate(self, messages: list[Message], **options: Any) -> str:
        if self._fn is not None:
            return self._fn(messages, **options)
        return self._template.format(prompt=last_user_text(messages))
