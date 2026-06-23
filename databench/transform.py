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

from dataclasses import dataclass
from typing import Any, Callable, Optional

from pydantic import BaseModel


@dataclass
class Transform:
    fn: Callable[..., Any]
    name: str
    version: str
    params_model: Optional[type[BaseModel]] = None

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
        return f"Transform(name={self.name!r}, version={self.version!r})"


def transform(
    name: Optional[str] = None,
    version: str = "1",
    params: Optional[type[BaseModel]] = None,
) -> Callable[[Callable[..., Any]], Transform]:
    """Decorator registering a function as a databench transform.

    Example::

        class Params(BaseModel):
            min_quality: float = 0.7

        @transform(version="1", params=Params)
        def filter_quality(ds, p):
            ...
    """

    def deco(fn: Callable[..., Any]) -> Transform:
        return Transform(fn=fn, name=name or fn.__name__, version=version, params_model=params)

    return deco
