"""Request admission and server-side endpoint policy."""

from __future__ import annotations

import re
from typing import Any

from .errors import RuntimePolicyError
from .model_endpoint_policy import (
    ModelEndpointPolicyV1 as EndpointPolicy,
    install_pinned_socket_transport_v1 as install_socket_guard,
)

_TASK_ID = re.compile(r'^(?:eval|perf)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
_CAMEL_BOUNDARY = re.compile(r'([a-z0-9])([A-Z])')
_KEY_PARTS = re.compile(r'[^a-z0-9]+')
_URI_VALUE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*:')
_WINDOWS_DRIVE = re.compile(r'^[A-Za-z]:[\\/]')
_FORBIDDEN_LOCATOR_PARTS = {
    'path',
    'paths',
    'dir',
    'dirs',
    'directory',
    'directories',
    'folder',
    'folders',
    'file',
    'files',
    'filename',
    'url',
    'urls',
    'uri',
    'uris',
    'location',
    'locations',
    'endpoint',
    'endpoints',
    'host',
    'hostname',
    'address',
    'bucket',
    'objectkey',
    'storage',
    'repo',
    'repository',
    'hub',
}
_FORBIDDEN_LOCATOR_KEYS = {
    'dataid',
    'datasetid',
    'repoid',
    'localpath',
    'rootpath',
    'basepath',
    'sourcepath',
    'datafile',
}


def validate_task_id(value: str) -> str:
    if not isinstance(value, str) or not _TASK_ID.fullmatch(value):
        raise RuntimePolicyError(
            'invalid_task_id',
            'Task ID must use eval_<uuid> or perf_<uuid>',
            400,
            '/headers/EvalScope-Task-Id',
        )
    return value


def _pointer_token(value: str) -> str:
    return value.replace('~', '~0').replace('/', '~1')


def _key_parts(key: str) -> tuple[str, ...]:
    separated = _CAMEL_BOUNDARY.sub(r'\1_\2', key).lower()
    return tuple(part for part in _KEY_PARTS.split(separated) if part)


def _is_locator_key(key: str) -> bool:
    parts = _key_parts(key)
    compact = ''.join(parts)
    return compact in _FORBIDDEN_LOCATOR_KEYS or any(part in _FORBIDDEN_LOCATOR_PARTS for part in parts)


def _is_forbidden_locator_value(value: str) -> bool:
    stripped = value.strip()
    if not stripped:
        return False
    if stripped.startswith(('/', '\\', '~/')) or _WINDOWS_DRIVE.match(stripped):
        return True
    if stripped.startswith('//') or stripped.startswith('\\\\') or _URI_VALUE.match(stripped):
        return True
    return '..' in re.split(r'[\\/]+', stripped)


def validate_dataset_args(value: Any, *, max_nodes: int = 10_000, max_depth: int = 32) -> None:
    """Reject every native dataset locator before task claim creation."""

    if not isinstance(value, dict):
        raise RuntimePolicyError(
            'dataset_args_invalid',
            'dataset_args must be a JSON object',
            422,
            '/dataset_args',
        )

    nodes = 0

    def visit(node: Any, pointer: str, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes or depth > max_depth:
            raise RuntimePolicyError(
                'dataset_args_too_complex',
                'dataset_args exceeds the configured complexity bound',
                422,
                pointer or '/dataset_args',
            )
        if isinstance(node, dict):
            for key, child in node.items():
                child_pointer = f'{pointer}/{_pointer_token(str(key))}'
                if not isinstance(key, str) or _is_locator_key(key):
                    raise RuntimePolicyError(
                        'dataset_args_locator_forbidden',
                        'dataset_args cannot contain path, file, URL, URI, host, or repository locators',
                        422,
                        child_pointer,
                    )
                visit(child, child_pointer, depth + 1)
        elif isinstance(node, list):
            for index, child in enumerate(node):
                visit(child, f'{pointer}/{index}', depth + 1)
        elif isinstance(node, str) and _is_forbidden_locator_value(node):
            raise RuntimePolicyError(
                'dataset_args_locator_forbidden',
                'dataset_args cannot contain absolute, traversing, drive, UNC, or URI-like values',
                422,
                pointer or '/dataset_args',
            )
        elif node is not None and not isinstance(node, (str, bool, int, float)):
            raise RuntimePolicyError(
                'dataset_args_invalid',
                'dataset_args must contain JSON values only',
                422,
                pointer or '/dataset_args',
            )

    visit(value, '/dataset_args', 0)
