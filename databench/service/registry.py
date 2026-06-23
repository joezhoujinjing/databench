"""Transform registry, reflected from :mod:`databench.ops`.

The service never reimplements transforms; it discovers the built-in
:class:`~databench.transform.Transform` instances declared in ``ops`` and
indexes them by name so they can be listed and invoked over HTTP.
"""

from __future__ import annotations

from databench import ops
from databench.transform import Transform


def build_registry() -> dict[str, Transform]:
    return {obj.name: obj for obj in vars(ops).values() if isinstance(obj, Transform)}


TRANSFORMS: dict[str, Transform] = build_registry()


def get_transform(name: str) -> Transform | None:
    return TRANSFORMS.get(name)
