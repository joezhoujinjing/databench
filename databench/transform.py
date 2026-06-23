"""The transform abstraction.

A transform is a pure function ``(Dataset, ...) -> Dataset`` (it may also return
a Polars frame, which the workspace coerces back into a Dataset). The
:func:`transform` decorator turns such a function into a :class:`Transform` that
carries:

* a stable ``name`` and ``version`` (the code version) - both feed the cache key
* an optional Pydantic params model, so parameters are typed and canonically
  hashable

The decorator does NOT run anything or touch storage. Execution, caching and
lineage recording all happen in :meth:`Workspace.run`, which is what guarantees
every materialised dataset has a recorded provenance edge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from pydantic import BaseModel

from .provenance import code_version, source_dir


@dataclass
class Transform:
    fn: Callable[..., Any]
    name: str
    version: Optional[str] = None  # manual override; None => auto code hash
    params_model: Optional[type[BaseModel]] = None
    code_version: str = field(init=False)
    source_dir: Optional[str] = field(init=False)

    def __post_init__(self) -> None:
        # Computed once at definition time and tied to the function's source.
        self.code_version = code_version(self.fn)
        self.source_dir = source_dir(self.fn)

    @property
    def effective_version(self) -> str:
        """The version that feeds the cache key and lineage (op_version)."""

        return self.version or self.code_version

    def build_params(self, kwargs: dict[str, Any]) -> tuple[Optional[BaseModel], dict[str, Any]]:
        """Validate kwargs into (params_obj, canonical_params_dict).

        The dict is what goes into the cache key, so it must be deterministic.
        """

        if self.params_model is None:
            if kwargs:
                raise TypeError(
                    f"transform {self.name!r} takes no params but got: {sorted(kwargs)}"
                )
            return None, {}
        obj = self.params_model(**kwargs)
        return obj, obj.model_dump(mode="json")

    def __repr__(self) -> str:
        return f"Transform(name={self.name!r}, version={self.effective_version!r})"


def transform(
    name: Optional[str] = None,
    version: Optional[str] = None,
    params: Optional[type[BaseModel]] = None,
) -> Callable[[Callable[..., Any]], Transform]:
    """Decorator registering a function as a databench transform.

    ``op_version`` defaults to a content hash of the function's source, so
    editing the transform invalidates its cache and creates a new lineage edge.
    Pass ``version`` to pin it manually instead.

    Example::

        class Params(BaseModel):
            min_quality: float = 0.7

        @transform(params=Params)
        def filter_quality(ds, p):
            ...
    """

    def deco(fn: Callable[..., Any]) -> Transform:
        return Transform(fn=fn, name=name or fn.__name__, version=version, params_model=params)

    return deco
