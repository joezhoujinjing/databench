"""Bounded Swift output discovery and deterministic LoRA artifact construction."""

from __future__ import annotations

import io
import json
import math
import os
import re
import secrets
import stat
import tarfile
import threading
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

import zstandard
from blake3 import blake3

from .errors import ProviderError

_HANDLE = re.compile(r'^swo_[A-Za-z0-9_-]{43}$')
_SHARD = re.compile(r'^adapter_model-(\d{5})-of-(\d{5})\.safetensors$')
_SAFE_MODEL_REFERENCE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$')
_SAFE_REVISION = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$')
_SAFE_SUMMARY_STRING = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$')
_CONTROL = re.compile(r'[\x00-\x1f\x7f\u2028\u2029]')
_CREDENTIAL_VALUE = re.compile(
    r'(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|'
    r'(?:\b(?:authorization|api[_-]?key|password|secret|token)\s*[:=]\s*\S+)',
    re.IGNORECASE,
)
_ARCHIVE_EXACT_FILES = frozenset(
    {
        'additional_config.json',
        'adapter_config.json',
        'adapter_model.safetensors',
        'adapter_model.safetensors.index.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'special_tokens_map.json',
        'added_tokens.json',
        'merges.txt',
        'vocab.json',
        'preprocessor_config.json',
        'processor_config.json',
        'chat_template.json',
    }
)
_SOURCE_ONLY_FILES = frozenset({'args.json'})
_EXCLUDED_EXACT_FILES = frozenset(
    {
        'README.md',
        'optimizer.pt',
        'predict.jsonl',
        'rng_state.pth',
        'scaler.pt',
        'scheduler.pt',
        'train.sh',
        'trainer_state.json',
        'training_args.bin',
    }
)
_RNG_STATE = re.compile(r'^rng_state(?:_\d+)?\.pth$')
_TENSORBOARD_EVENT = re.compile(r'^events\.out\.tfevents\.[A-Za-z0-9._-]+$')
_JSON_FILES = frozenset(name for name in _ARCHIVE_EXACT_FILES if name.endswith('.json'))
_ADAPTER_SUMMARY_FIELDS = {
    'peft_type': 'peft_type',
    'task_type': 'task_type',
    'r': 'rank',
    'lora_alpha': 'alpha',
    'lora_dropout': 'dropout',
    'bias': 'bias',
}
_TRAINING_FIELDS = {
    'train_type': 'stage',
    'train_stage': 'stage',
    'stage': 'stage',
    'tuner_type': 'tuner_type',
    'lora_rank': 'lora_rank',
    'lora_alpha': 'lora_alpha',
    'lora_dropout': 'lora_dropout',
    'num_train_epochs': 'epochs',
    'max_steps': 'max_steps',
    'learning_rate': 'learning_rate',
    'max_length': 'max_length',
    'torch_dtype': 'dtype',
    'dtype': 'dtype',
    'seed': 'seed',
}
_KNOWN_ADAPTER_FIELDS = frozenset(
    {
        *_ADAPTER_SUMMARY_FIELDS,
        'target_modules',
        'base_model_name_or_path',
        'revision',
    }
)
_KNOWN_ARGS_FIELDS = frozenset(
    {
        *_TRAINING_FIELDS,
        'dataset',
        'model',
        'model_revision',
    }
)
_ARCHIVE_MODE = 0o444
_ARCHIVE_FORMAT = 'deterministic-tar-zst-v1'
_ARTIFACT_FORMAT = 'swift-lora-adapter-v1'
_ZSTD_LEVEL = 9
_CHUNK_BYTES = 1024 * 1024
_SAFETENSORS_DTYPE_BYTES = {
    'BOOL': 1,
    'U8': 1,
    'I8': 1,
    'F8_E4M3': 1,
    'F8_E5M2': 1,
    'U16': 2,
    'I16': 2,
    'F16': 2,
    'BF16': 2,
    'U32': 4,
    'I32': 4,
    'F32': 4,
    'U64': 8,
    'I64': 8,
    'F64': 8,
}


@dataclass(frozen=True)
class ArtifactLimits:
    max_scan_entries: int = 1024
    max_candidates: int = 256
    max_handles: int = 4096
    max_files: int = 64
    max_file_bytes: int = 32 * 1024 * 1024 * 1024
    max_total_bytes: int = 64 * 1024 * 1024 * 1024
    max_json_bytes: int = 16 * 1024 * 1024
    max_args_bytes: int = 1024 * 1024

    def __post_init__(self) -> None:
        values = (
            self.max_scan_entries,
            self.max_candidates,
            self.max_handles,
            self.max_files,
            self.max_file_bytes,
            self.max_total_bytes,
            self.max_json_bytes,
            self.max_args_bytes,
        )
        if any(
            not isinstance(value, int) or isinstance(value, bool) or value < 1
            for value in values
        ):
            raise ValueError('Artifact limits must be positive integers')
        if self.max_candidates > self.max_scan_entries:
            raise ValueError('Artifact candidate bound cannot exceed the scan bound')
        if self.max_json_bytes > self.max_file_bytes:
            raise ValueError('Artifact JSON bound cannot exceed the file bound')
        if self.max_args_bytes > self.max_json_bytes:
            raise ValueError('Artifact args bound cannot exceed the JSON bound')
        if self.max_file_bytes > self.max_total_bytes:
            raise ValueError('Artifact file bound cannot exceed the total bound')


@dataclass(frozen=True)
class ArtifactSessionContext:
    provider_generation: str
    provider_session_id: str
    session_root: Path
    dataset_version: str
    export_digest: str
    export_size_bytes: int
    output_count: int


class ArtifactSessionContextProvider(Protocol):
    def artifact_context(self, provider_session_id: str) -> ArtifactSessionContext: ...


@dataclass(frozen=True)
class OutputCandidate:
    handle: str | None
    output_snapshot_digest: str | None
    display_name: str
    candidate_kinds: tuple[str, ...]
    size_bytes: int
    modified_at_ns: int
    importable: bool
    reason: str | None


@dataclass(frozen=True)
class ArtifactBuildResult:
    archive_digest: str
    archive_size_bytes: int
    provider_metadata: Mapping[str, Any]


@dataclass(frozen=True)
class _FileSnapshot:
    path: str
    size_bytes: int
    digest: str
    device: int
    inode: int
    mode: int
    modified_at_ns: int
    archived: bool


@dataclass(frozen=True)
class _CandidateSnapshot:
    relative_path: str
    directory_device: int
    directory_inode: int
    directory_modified_at_ns: int
    files: tuple[_FileSnapshot, ...]
    archive_size_bytes: int
    modified_at_ns: int
    sanitized_metadata: Mapping[str, Any]


@dataclass(frozen=True)
class _SafetensorsInspection:
    tensor_names: frozenset[str]
    data_size_bytes: int


@dataclass(frozen=True)
class _HandleRecord:
    provider_generation: str
    provider_session_id: str
    snapshot: _CandidateSnapshot


def _provider_error(code: str, message: str, status: int = 409) -> ProviderError:
    return ProviderError(code, message, status)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _name_bytes(name: str) -> bytes:
    try:
        encoded = name.encode('utf-8')
    except UnicodeEncodeError as exc:
        raise _provider_error(
            'output_candidate_name_invalid',
            'Swift output contains a non-UTF-8 candidate name',
        ) from exc
    if (
        not encoded
        or len(encoded) > 255
        or name in {'.', '..'}
        or '/' in name
        or '\\' in name
        or _CONTROL.search(name)
    ):
        raise _provider_error(
            'output_candidate_name_invalid',
            'Swift output contains an invalid candidate name',
        )
    return encoded


def _valid_tensor_name(value: Any) -> bool:
    if not isinstance(value, str) or not value or _CONTROL.search(value):
        return False
    try:
        encoded = value.encode('utf-8')
    except UnicodeEncodeError:
        return False
    return len(encoded) <= 4096


def _bounded_names(descriptor: int, maximum: int) -> list[str]:
    try:
        names = os.listdir(descriptor)
    except OSError as exc:
        raise _provider_error(
            'output_discovery_unavailable',
            'Swift output directory is unavailable',
            503,
        ) from exc
    if len(names) > maximum:
        raise _provider_error(
            'output_discovery_limit_exceeded',
            'Swift output exceeds the discovery entry bound',
            413,
        )
    for name in names:
        _name_bytes(name)
    return sorted(names, key=_name_bytes)


def _open_directory(path: Path) -> int:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise _provider_error(
            'output_directory_not_found',
            'Swift output directory was not found',
            404,
        ) from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise _provider_error(
            'output_directory_invalid',
            'Swift output directory is not an exact directory',
        )
    try:
        return os.open(
            path,
            os.O_RDONLY
            | getattr(os, 'O_DIRECTORY', 0)
            | getattr(os, 'O_NOFOLLOW', 0),
        )
    except OSError as exc:
        raise _provider_error(
            'output_directory_unavailable',
            'Swift output directory is unavailable',
            503,
        ) from exc


def _open_child_directory(parent: int, name: str) -> int:
    _name_bytes(name)
    try:
        return os.open(
            name,
            os.O_RDONLY
            | getattr(os, 'O_DIRECTORY', 0)
            | getattr(os, 'O_NOFOLLOW', 0),
            dir_fd=parent,
        )
    except OSError as exc:
        raise _provider_error(
            'output_candidate_unsafe_path',
            'Swift output candidate is not an exact directory',
        ) from exc


def _relative_components(value: str) -> tuple[str, ...]:
    path = PurePosixPath(value)
    parts = path.parts
    if len(parts) not in {1, 2} or path.is_absolute() or any(part in {'.', '..'} for part in parts):
        raise _provider_error(
            'output_handle_invalid',
            'Swift output handle does not bind an accepted candidate',
            422,
        )
    for part in parts:
        _name_bytes(part)
    return parts


def _open_candidate(output_descriptor: int, relative_path: str) -> int:
    current = os.dup(output_descriptor)
    try:
        for part in _relative_components(relative_path):
            child = _open_child_directory(current, part)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


def _stat_at(descriptor: int, name: str) -> os.stat_result:
    try:
        return os.stat(name, dir_fd=descriptor, follow_symlinks=False)
    except FileNotFoundError as exc:
        raise _provider_error(
            'output_snapshot_changed',
            'Swift output candidate changed after discovery',
        ) from exc
    except OSError as exc:
        raise _provider_error(
            'output_candidate_unavailable',
            'Swift output candidate is unavailable',
            503,
        ) from exc


def _same_stat(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_mode == right.st_mode
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
    )


def _read_snapshot_file(
    directory: int,
    name: str,
    metadata: os.stat_result,
    *,
    maximum_bytes: int,
    collect_bytes: int | None,
) -> tuple[_FileSnapshot, bytes | None]:
    _validate_regular_file_metadata(metadata, maximum_bytes)
    if collect_bytes is not None and metadata.st_size > collect_bytes:
        raise _provider_error(
            'output_candidate_metadata_too_large',
            'Swift output candidate metadata exceeds its byte bound',
            413,
        )
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0),
            dir_fd=directory,
        )
    except OSError as exc:
        raise _provider_error(
            'output_candidate_unsafe_file',
            'Swift output candidate file cannot be opened safely',
        ) from exc
    hasher = blake3()
    measured = 0
    collected = bytearray() if collect_bytes is not None else None
    try:
        opened = os.fstat(descriptor)
        if not _same_stat(metadata, opened) or not stat.S_ISREG(opened.st_mode):
            raise _provider_error(
                'output_snapshot_changed',
                'Swift output candidate changed while it was inspected',
            )
        while True:
            chunk = os.read(descriptor, _CHUNK_BYTES)
            if not chunk:
                break
            measured += len(chunk)
            if measured > maximum_bytes:
                raise _provider_error(
                    'output_candidate_file_too_large',
                    'Swift output candidate file exceeds its byte bound',
                    413,
                )
            hasher.update(chunk)
            if collected is not None:
                collected.extend(chunk)
        finished = os.fstat(descriptor)
        if (
            measured != metadata.st_size
            or not _same_stat(opened, finished)
            or not _same_stat(metadata, finished)
        ):
            raise _provider_error(
                'output_snapshot_changed',
                'Swift output candidate changed while it was inspected',
            )
    finally:
        os.close(descriptor)
    return (
        _FileSnapshot(
            path=name,
            size_bytes=measured,
            digest=hasher.hexdigest(),
            device=metadata.st_dev,
            inode=metadata.st_ino,
            mode=metadata.st_mode,
            modified_at_ns=metadata.st_mtime_ns,
            archived=name != 'args.json',
        ),
        bytes(collected) if collected is not None else None,
    )


def _read_exact(descriptor: int, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = os.read(descriptor, size - len(chunks))
        if not chunk:
            break
        chunks.extend(chunk)
    return bytes(chunks)


def _json_without_duplicates(raw: bytes, code: str) -> Any:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result

    def invalid_constant(_: str) -> None:
        raise ValueError('non-finite JSON number')

    try:
        value = json.loads(
            raw.decode('utf-8'),
            object_pairs_hook=object_pairs,
            parse_constant=invalid_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise _provider_error(
            code,
            'Swift output candidate contains invalid JSON metadata',
        ) from exc
    nodes = 0

    def inspect(item: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > 100_000 or depth > 32:
            raise _provider_error(
                code,
                'Swift output candidate JSON metadata exceeds its shape bound',
                413,
            )
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise _provider_error(code, 'Swift output candidate JSON key is invalid')
                inspect(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                inspect(child, depth + 1)
        elif isinstance(item, float) and not math.isfinite(item):
            raise _provider_error(code, 'Swift output candidate JSON number is invalid')

    inspect(value, 0)
    return value


def _inspect_safetensors(
    directory: int,
    snapshot: _FileSnapshot,
    *,
    maximum_header_bytes: int,
) -> _SafetensorsInspection:
    try:
        descriptor = os.open(
            snapshot.path,
            os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0),
            dir_fd=directory,
        )
    except OSError as exc:
        raise _provider_error(
            'output_candidate_unsafe_file',
            'LoRA safetensors file cannot be opened safely',
        ) from exc
    try:
        before = os.fstat(descriptor)
        if (
            before.st_dev != snapshot.device
            or before.st_ino != snapshot.inode
            or before.st_mode != snapshot.mode
            or before.st_size != snapshot.size_bytes
            or before.st_mtime_ns != snapshot.modified_at_ns
        ):
            raise _provider_error(
                'output_snapshot_changed',
                'LoRA safetensors file changed before header inspection',
            )
        prefix = _read_exact(descriptor, 8)
        if len(prefix) != 8:
            raise _provider_error(
                'output_candidate_safetensors_invalid',
                'LoRA safetensors file is missing its bounded header',
            )
        header_size = int.from_bytes(prefix, byteorder='little', signed=False)
        if (
            header_size < 8
            or header_size % 8 != 0
            or header_size > maximum_header_bytes
            or header_size > snapshot.size_bytes - 8
        ):
            raise _provider_error(
                'output_candidate_safetensors_invalid',
                'LoRA safetensors header length is invalid',
            )
        raw_header = _read_exact(descriptor, header_size)
        if len(raw_header) != header_size or not raw_header.startswith(b'{'):
            raise _provider_error(
                'output_candidate_safetensors_invalid',
                'LoRA safetensors header is truncated or malformed',
            )
        header = _json_without_duplicates(
            raw_header,
            'output_candidate_safetensors_invalid',
        )
        if not isinstance(header, dict):
            raise _provider_error(
                'output_candidate_safetensors_invalid',
                'LoRA safetensors header must be an object',
            )
        metadata = header.get('__metadata__')
        if metadata is not None and (
            not isinstance(metadata, dict)
            or any(
                not isinstance(key, str) or not isinstance(value, str)
                for key, value in metadata.items()
            )
        ):
            raise _provider_error(
                'output_candidate_safetensors_invalid',
                'LoRA safetensors metadata must contain only string values',
            )
        data_size_bytes = snapshot.size_bytes - 8 - header_size
        ranges: list[tuple[int, int, str]] = []
        tensor_names: set[str] = set()
        for name, tensor in header.items():
            if name == '__metadata__':
                continue
            if (
                not _valid_tensor_name(name)
                or not isinstance(tensor, dict)
                or set(tensor) != {'dtype', 'shape', 'data_offsets'}
            ):
                raise _provider_error(
                    'output_candidate_safetensors_invalid',
                    'LoRA safetensors tensor metadata is invalid',
                )
            dtype = tensor.get('dtype')
            shape = tensor.get('shape')
            offsets = tensor.get('data_offsets')
            element_bytes = (
                _SAFETENSORS_DTYPE_BYTES.get(dtype)
                if isinstance(dtype, str)
                else None
            )
            if (
                element_bytes is None
                or not isinstance(shape, list)
                or len(shape) > 32
                or any(
                    not isinstance(dimension, int)
                    or isinstance(dimension, bool)
                    or dimension < 0
                    for dimension in shape
                )
                or not isinstance(offsets, list)
                or len(offsets) != 2
                or any(
                    not isinstance(offset, int)
                    or isinstance(offset, bool)
                    for offset in offsets
                )
            ):
                raise _provider_error(
                    'output_candidate_safetensors_invalid',
                    'LoRA safetensors tensor shape or dtype is invalid',
                )
            start, end = offsets
            assert isinstance(start, int) and isinstance(end, int)
            if start < 0 or end < start or end > data_size_bytes:
                raise _provider_error(
                    'output_candidate_safetensors_invalid',
                    'LoRA safetensors tensor range is outside the data section',
                )
            element_count = 1
            for dimension in shape:
                element_count *= dimension
                if element_count * element_bytes > data_size_bytes:
                    raise _provider_error(
                        'output_candidate_safetensors_invalid',
                        'LoRA safetensors tensor shape exceeds the data section',
                    )
            if end - start != element_count * element_bytes:
                raise _provider_error(
                    'output_candidate_safetensors_invalid',
                    'LoRA safetensors tensor range does not match its shape',
                )
            tensor_names.add(name)
            ranges.append((start, end, name))
        if not tensor_names or data_size_bytes < 1:
            raise _provider_error(
                'output_candidate_safetensors_invalid',
                'LoRA safetensors file contains no tensor data',
            )
        expected_start = 0
        for start, end, _ in sorted(ranges, key=lambda item: (item[0], item[1], item[2])):
            if start != expected_start:
                raise _provider_error(
                    'output_candidate_safetensors_invalid',
                    'LoRA safetensors tensor ranges are not contiguous',
                )
            expected_start = end
        if expected_start != data_size_bytes:
            raise _provider_error(
                'output_candidate_safetensors_invalid',
                'LoRA safetensors data section is not fully bound by tensors',
            )
        after = os.fstat(descriptor)
        if not _same_stat(before, after):
            raise _provider_error(
                'output_snapshot_changed',
                'LoRA safetensors file changed during header inspection',
            )
        return _SafetensorsInspection(
            tensor_names=frozenset(tensor_names),
            data_size_bytes=data_size_bytes,
        )
    finally:
        os.close(descriptor)


def _allowed_role(name: str) -> str | None:
    if name in _SOURCE_ONLY_FILES:
        return 'source'
    if name in _ARCHIVE_EXACT_FILES or _SHARD.fullmatch(name):
        return 'archive'
    if (
        name in _EXCLUDED_EXACT_FILES
        or _RNG_STATE.fullmatch(name)
        or _TENSORBOARD_EVENT.fullmatch(name)
        or name.endswith('.log')
    ):
        return 'excluded'
    return None


def _validate_regular_file_metadata(metadata: os.stat_result, maximum_bytes: int) -> None:
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise _provider_error(
            'output_candidate_unsafe_file',
            'Swift output candidate contains a non-regular file',
        )
    if metadata.st_size < 0 or metadata.st_size > maximum_bytes:
        raise _provider_error(
            'output_candidate_file_too_large',
            'Swift output candidate file exceeds its byte bound',
            413,
        )


def _safe_summary_string(value: Any) -> str | None:
    if (
        not isinstance(value, str)
        or _SAFE_SUMMARY_STRING.fullmatch(value) is None
        or _CONTROL.search(value)
    ):
        return None
    return value


def _safe_number(
    value: Any,
    *,
    minimum: int | float,
    maximum: int | float,
    minimum_inclusive: bool = True,
) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value > maximum or (value < minimum if minimum_inclusive else value <= minimum):
        return None
    return value


def _safe_integer(
    value: Any,
    *,
    minimum: int,
    maximum: int = 9_007_199_254_740_991,
) -> int | None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        return None
    return value


def _safe_model_part(value: Any, pattern: re.Pattern[str]) -> str | None:
    if not isinstance(value, str) or pattern.fullmatch(value) is None or _CONTROL.search(value):
        return None
    path = PurePosixPath(value)
    if (
        value.startswith(('/', '~', './', '../'))
        or '://' in value
        or '//' in value
        or any(part in {'.', '..'} for part in path.parts)
    ):
        return None
    return value


def _sanitize_metadata(
    context: ArtifactSessionContext,
    adapter_config: Mapping[str, Any],
    args: Mapping[str, Any],
) -> dict[str, Any]:
    adapter: dict[str, Any] = {}
    redacted_fields = len(set(adapter_config) - _KNOWN_ADAPTER_FIELDS)
    for source, target in _ADAPTER_SUMMARY_FIELDS.items():
        value = adapter_config.get(source)
        if source == 'r':
            sanitized = _safe_integer(value, minimum=1, maximum=65_536)
        elif source == 'lora_alpha':
            sanitized = _safe_number(value, minimum=0, maximum=1_000_000)
        elif source == 'lora_dropout':
            sanitized = _safe_number(value, minimum=0, maximum=1)
        else:
            sanitized = _safe_summary_string(value)
        if sanitized is not None:
            adapter[target] = sanitized
        elif source in adapter_config:
            redacted_fields += 1
    target_modules = adapter_config.get('target_modules')
    if isinstance(target_modules, list) and 0 < len(target_modules) <= 256:
        normalized_modules = {
            item
            for item in target_modules
            if _safe_summary_string(item) is not None
        }
        if len(normalized_modules) == len(target_modules):
            adapter['target_modules'] = sorted(normalized_modules, key=lambda item: item.encode('utf-8'))
        else:
            redacted_fields += 1
    elif 'target_modules' in adapter_config:
        redacted_fields += 1

    training: dict[str, Any] = {
        'train_stage': None,
        'tuner_type': 'lora',
        'lora_rank': None,
        'lora_alpha': None,
        'lora_dropout': None,
        'num_train_epochs': None,
        'max_steps': None,
        'learning_rate': None,
        'max_length': None,
        'dtype': None,
        'seed': None,
    }
    redacted_fields += len(set(args) - _KNOWN_ARGS_FIELDS)
    for source, target in _TRAINING_FIELDS.items():
        if source not in args:
            continue
        value = args[source]
        if target == 'lora_rank':
            sanitized = _safe_integer(value, minimum=1, maximum=65_536)
        elif target in {'max_steps', 'max_length'}:
            sanitized = _safe_integer(value, minimum=1)
        elif target == 'seed':
            sanitized = _safe_integer(value, minimum=-9_007_199_254_740_991)
        elif target == 'lora_alpha':
            sanitized = _safe_number(value, minimum=0, maximum=1_000_000)
        elif target == 'lora_dropout':
            sanitized = _safe_number(value, minimum=0, maximum=1)
        elif target == 'epochs':
            sanitized = _safe_number(
                value,
                minimum=0,
                maximum=1_000_000,
                minimum_inclusive=False,
            )
        elif target == 'learning_rate':
            sanitized = _safe_number(
                value,
                minimum=0,
                maximum=1,
                minimum_inclusive=False,
            )
        else:
            sanitized = _safe_summary_string(value)
        if sanitized is None:
            redacted_fields += 1
        else:
            training[
                {
                    'stage': 'train_stage',
                    'epochs': 'num_train_epochs',
                }.get(target, target)
            ] = sanitized

    adapter_reference = _safe_model_part(
        adapter_config.get('base_model_name_or_path'),
        _SAFE_MODEL_REFERENCE,
    )
    args_reference = _safe_model_part(args.get('model'), _SAFE_MODEL_REFERENCE)
    reference = adapter_reference or args_reference
    revision = _safe_model_part(
        adapter_config.get('revision') or args.get('model_revision'),
        _SAFE_REVISION,
    )
    binding_status = 'declared' if reference is not None else 'unresolved'
    if (
        adapter_reference is not None
        and args_reference is not None
        and adapter_reference != args_reference
    ):
        binding_status = 'unresolved'

    expected_dataset = str(context.session_root / 'input' / 'ms-swift.jsonl')
    dataset_value = args.get('dataset')
    if isinstance(dataset_value, str):
        datasets = [dataset_value]
    elif isinstance(dataset_value, list) and all(isinstance(item, str) for item in dataset_value):
        datasets = dataset_value
    else:
        datasets = []
    verified_lineage = datasets == [expected_dataset]
    lineage: dict[str, Any] = {
        'status': 'verified' if verified_lineage else 'external_or_unverified',
        'dataset_version': None,
        'dataset_export_digest': None,
    }
    if verified_lineage:
        lineage.update(
            {
                'dataset_version': context.dataset_version,
                'dataset_export_digest': context.export_digest,
            }
        )

    training['redacted_fields_count'] = redacted_fields
    return {
        'provider_metadata_version': 'swift-lora-snapshot-v1',
        'artifact_kind': 'lora_adapter',
        'artifact_format': _ARTIFACT_FORMAT,
        'archive_format': _ARCHIVE_FORMAT,
        'source': {
            'provider_generation': context.provider_generation,
            'provider_session_id': context.provider_session_id,
        },
        'adapter': adapter,
        'base_model': {
            'reference': reference,
            'revision': revision,
            'binding_status': binding_status,
        },
        'training_summary': training,
        'dataset_lineage': lineage,
    }


def _exact_dataset_export_matches(context: ArtifactSessionContext) -> bool:
    path = context.session_root / 'input' / 'ms-swift.jsonl'
    try:
        path_metadata = path.lstat()
        if stat.S_ISLNK(path_metadata.st_mode) or not stat.S_ISREG(path_metadata.st_mode):
            return False
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0),
        )
    except OSError:
        return False
    try:
        before = os.fstat(descriptor)
        digest = blake3()
        size_bytes = 0
        line_count = 0
        while True:
            chunk = os.read(descriptor, _CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            size_bytes += len(chunk)
            line_count += chunk.count(b'\n')
        after = os.fstat(descriptor)
        try:
            current = path.lstat()
        except OSError:
            return False
        stable = (
            before.st_dev == after.st_dev == current.st_dev
            and before.st_ino == after.st_ino == current.st_ino
            and before.st_size == after.st_size == current.st_size
            and before.st_mtime_ns == after.st_mtime_ns == current.st_mtime_ns
        )
        return (
            stable
            and stat.S_ISREG(after.st_mode)
            and size_bytes == context.export_size_bytes
            and line_count == context.output_count
            and digest.hexdigest() == context.export_digest
        )
    except OSError:
        return False
    finally:
        os.close(descriptor)


def _reject_sensitive_adapter_config(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if _sensitive_metadata_key(key):
                raise _provider_error(
                    'output_candidate_metadata_sensitive',
                    'LoRA adapter metadata contains a credential-bearing field',
                )
            _reject_sensitive_adapter_config(child)
    elif isinstance(value, list):
        for child in value:
            _reject_sensitive_adapter_config(child)
    elif isinstance(value, str) and _CREDENTIAL_VALUE.search(value):
        raise _provider_error(
            'output_candidate_metadata_sensitive',
            'LoRA adapter metadata contains a credential-like value',
        )


def _sensitive_metadata_key(value: Any) -> bool:
    if not isinstance(value, str):
        return True
    normalized = value.lower().replace('-', '_')
    exact = {
        'authorization',
        'api_key',
        'apikey',
        'password',
        'secret',
        'token',
        'env',
        'environment',
        'plugin',
        'plugins',
    }
    suffixes = (
        '_authorization',
        '_api_key',
        '_apikey',
        '_password',
        '_secret',
        '_token',
        '_env',
        '_environment',
        '_plugin',
    )
    return normalized in exact or normalized.endswith(suffixes)


def _validate_additional_adapter_config(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {
        'lora_dtype',
        'lorap_lr_ratio',
        'lorap_emb_lr',
    }:
        raise _provider_error(
            'output_candidate_additional_config_invalid',
            'LoRA additional_config.json must use the locked ms-swift shape',
        )
    lora_dtype = value.get('lora_dtype')
    if lora_dtype is not None and lora_dtype not in {
        'float16',
        'bfloat16',
        'float32',
    }:
        raise _provider_error(
            'output_candidate_additional_config_invalid',
            'LoRA additional_config.json has an unsupported adapter dtype',
        )
    for field, allow_null in (
        ('lorap_lr_ratio', True),
        ('lorap_emb_lr', False),
    ):
        field_value = value.get(field)
        if field_value is None and allow_null:
            continue
        if (
            _safe_number(
                field_value,
                minimum=0,
                maximum=1_000_000,
            )
            is None
        ):
            raise _provider_error(
                'output_candidate_additional_config_invalid',
                'LoRA additional_config.json has an invalid learning-rate value',
            )


def _output_snapshot_digest(snapshot: _CandidateSnapshot) -> str:
    payload = json.dumps(
        {
            'relative_candidate_path': snapshot.relative_path,
            'files': [
                {
                    'path': item.path,
                    'digest': item.digest,
                    'size_bytes': item.size_bytes,
                    'archived': item.archived,
                }
                for item in snapshot.files
            ],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
        allow_nan=False,
    ).encode('utf-8')
    return blake3(payload).hexdigest()


def _validate_shards(
    names: set[str],
    index_payload: Any,
    weights: Mapping[str, _SafetensorsInspection],
) -> None:
    single = 'adapter_model.safetensors' in names
    shards = sorted(
        (name for name in names if _SHARD.fullmatch(name)),
        key=lambda name: name.encode('utf-8'),
    )
    has_index = 'adapter_model.safetensors.index.json' in names
    if single:
        if shards or has_index:
            raise _provider_error(
                'output_candidate_adapter_shape_invalid',
                'LoRA output mixes single-file and sharded adapter weights',
            )
        if set(weights) != {'adapter_model.safetensors'}:
            raise _provider_error(
                'output_candidate_adapter_shape_invalid',
                'LoRA output does not bind its exact single-file adapter weight',
            )
        return
    if not shards or not has_index:
        raise _provider_error(
            'output_candidate_adapter_shape_invalid',
            'LoRA output is missing its exact safetensors weight shape',
        )
    totals: set[int] = set()
    indices: set[int] = set()
    for name in shards:
        match = _SHARD.fullmatch(name)
        assert match is not None
        index = int(match.group(1))
        total = int(match.group(2))
        if index < 1 or total < 1 or index > total:
            raise _provider_error(
                'output_candidate_adapter_shape_invalid',
                'LoRA output has an invalid shard filename',
            )
        indices.add(index)
        totals.add(total)
    if len(totals) != 1:
        raise _provider_error(
            'output_candidate_adapter_shape_invalid',
            'LoRA output shard totals do not agree',
        )
    total = next(iter(totals))
    if indices != set(range(1, total + 1)) or len(shards) != total:
        raise _provider_error(
            'output_candidate_adapter_shape_invalid',
            'LoRA output shard set is incomplete',
        )
    if not isinstance(index_payload, dict) or set(index_payload) - {'metadata', 'weight_map'}:
        raise _provider_error(
            'output_candidate_adapter_shape_invalid',
            'LoRA output shard index has an invalid shape',
        )
    weight_map = index_payload.get('weight_map')
    if (
        not isinstance(weight_map, dict)
        or not weight_map
        or any(
            not _valid_tensor_name(key)
            or not isinstance(value, str)
            for key, value in weight_map.items()
        )
        or set(weight_map.values()) != set(shards)
    ):
        raise _provider_error(
            'output_candidate_adapter_shape_invalid',
            'LoRA output shard index does not bind the exact shard set',
        )
    if set(weights) != set(shards):
        raise _provider_error(
            'output_candidate_adapter_shape_invalid',
            'LoRA output does not bind the exact safetensors shard set',
        )
    for shard in shards:
        expected_tensors = {
            tensor_name
            for tensor_name, mapped_shard in weight_map.items()
            if mapped_shard == shard
        }
        if weights[shard].tensor_names != expected_tensors:
            raise _provider_error(
                'output_candidate_adapter_shape_invalid',
                'LoRA output shard index does not match safetensors tensor headers',
            )
    metadata = index_payload.get('metadata')
    if metadata is not None:
        if not isinstance(metadata, dict):
            raise _provider_error(
                'output_candidate_adapter_shape_invalid',
                'LoRA output shard index metadata is invalid',
            )
        total_size = metadata.get('total_size')
        if (
            total_size is not None
            and (
                not isinstance(total_size, int)
                or isinstance(total_size, bool)
                or total_size < 0
                or total_size
                != sum(inspection.data_size_bytes for inspection in weights.values())
            )
        ):
            raise _provider_error(
                'output_candidate_adapter_shape_invalid',
                'LoRA output shard index total size does not match safetensors data',
            )


def _output_root(context: ArtifactSessionContext) -> tuple[Path, int]:
    session_root = context.session_root
    try:
        session_metadata = session_root.lstat()
        resolved_session = session_root.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise _provider_error(
            'provider_session_not_found',
            'Swift Studio Provider Session was not found',
            404,
        ) from exc
    if stat.S_ISLNK(session_metadata.st_mode) or not stat.S_ISDIR(session_metadata.st_mode):
        raise _provider_error(
            'session_path_invalid',
            'Swift Studio Provider Session path is invalid',
            500,
        )
    output = resolved_session / 'output'
    descriptor = _open_directory(output)
    try:
        resolved_output = output.resolve(strict=True)
        if resolved_output.parent != resolved_session:
            raise _provider_error(
                'output_directory_invalid',
                'Swift output directory escaped its exact Session root',
            )
    except Exception:
        os.close(descriptor)
        raise
    return resolved_output, descriptor


class _DigestWriter:
    def __init__(self, raw: io.BufferedWriter, maximum_bytes: int | None = None) -> None:
        self.raw = raw
        self.hasher = blake3()
        self.size = 0
        self.maximum_bytes = maximum_bytes

    def write(self, value: bytes) -> int:
        if self.maximum_bytes is not None and len(value) > self.maximum_bytes - self.size:
            raise _provider_error(
                'artifact_archive_too_large',
                'Artifact archive exceeds the staging byte limit',
                413,
            )
        written = self.raw.write(value)
        if written:
            self.hasher.update(memoryview(value)[:written])
            self.size += written
        return written

    def flush(self) -> None:
        self.raw.flush()


class _SnapshotReader(io.RawIOBase):
    def __init__(self, descriptor: int, expected: _FileSnapshot) -> None:
        self._descriptor = descriptor
        self._expected = expected
        self._hasher = blake3()
        self._size = 0
        self._before = os.fstat(descriptor)
        if (
            self._before.st_dev != expected.device
            or self._before.st_ino != expected.inode
            or self._before.st_mode != expected.mode
            or self._before.st_size != expected.size_bytes
            or self._before.st_mtime_ns != expected.modified_at_ns
        ):
            raise _provider_error(
                'output_snapshot_changed',
                'Swift output candidate changed before archive construction',
            )

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        value = os.read(self._descriptor, _CHUNK_BYTES if size < 0 else size)
        if value:
            self._hasher.update(value)
            self._size += len(value)
        return value

    def verify(self) -> None:
        after = os.fstat(self._descriptor)
        if (
            self._size != self._expected.size_bytes
            or self._hasher.hexdigest() != self._expected.digest
            or not _same_stat(self._before, after)
        ):
            raise _provider_error(
                'output_snapshot_changed',
                'Swift output candidate changed during archive construction',
            )

    def close(self) -> None:
        if not self.closed:
            os.close(self._descriptor)
        super().close()


class ArtifactCore:
    """Process-generation-bound output handles and deterministic LoRA archives."""

    def __init__(
        self,
        contexts: ArtifactSessionContextProvider,
        *,
        limits: ArtifactLimits | None = None,
        token_factory: Callable[[int], str] = secrets.token_urlsafe,
    ) -> None:
        self._contexts = contexts
        self._limits = limits or ArtifactLimits()
        self._token_factory = token_factory
        self._handles: OrderedDict[str, _HandleRecord] = OrderedDict()
        self._handle_lock = threading.Lock()

    def discover(self, provider_session_id: str) -> tuple[OutputCandidate, ...]:
        context = self._contexts.artifact_context(provider_session_id)
        _, output_descriptor = _output_root(context)
        try:
            candidates = self._candidate_paths(output_descriptor)
            result: list[OutputCandidate] = []
            for relative_path in candidates:
                display_name = PurePosixPath(relative_path).name
                try:
                    snapshot = self._snapshot_candidate(
                        context,
                        output_descriptor,
                        relative_path,
                    )
                except ProviderError as error:
                    result.append(
                        OutputCandidate(
                            handle=None,
                            output_snapshot_digest=None,
                            display_name=display_name,
                            candidate_kinds=(),
                            size_bytes=0,
                            modified_at_ns=0,
                            importable=False,
                            reason=error.code,
                        )
                    )
                    continue
                handle = self._store_handle(context, snapshot)
                result.append(
                    OutputCandidate(
                        handle=handle,
                        output_snapshot_digest=_output_snapshot_digest(snapshot),
                        display_name=display_name,
                        candidate_kinds=('lora_adapter',),
                        size_bytes=snapshot.archive_size_bytes,
                        modified_at_ns=snapshot.modified_at_ns,
                        importable=True,
                        reason=None,
                    )
                )
            return tuple(result)
        finally:
            os.close(output_descriptor)

    def snapshot_identity(
        self,
        provider_session_id: str,
        handle: str,
    ) -> tuple[str, str]:
        """Return the generation and exact snapshot digest bound to an opaque handle."""
        if not isinstance(handle, str) or _HANDLE.fullmatch(handle) is None:
            raise _provider_error(
                'output_handle_invalid',
                'Swift output handle is invalid',
                422,
            )
        with self._handle_lock:
            record = self._handles.get(handle)
        if record is None or record.provider_session_id != provider_session_id:
            raise _provider_error(
                'output_handle_stale',
                'Swift output handle is stale or belongs to another Session',
                409,
            )
        context = self._contexts.artifact_context(provider_session_id)
        if context.provider_generation != record.provider_generation:
            raise _provider_error(
                'output_handle_stale',
                'Swift output handle belongs to another Provider generation',
                409,
            )
        return record.provider_generation, _output_snapshot_digest(record.snapshot)

    def build_lora_adapter(
        self,
        handle: str,
        destination: Path,
        *,
        max_archive_bytes: int | None = None,
    ) -> ArtifactBuildResult:
        if max_archive_bytes is not None and (
            not isinstance(max_archive_bytes, int)
            or isinstance(max_archive_bytes, bool)
            or max_archive_bytes < 1
        ):
            raise _provider_error(
                'artifact_archive_limit_invalid',
                'Artifact archive byte limit is invalid',
                422,
            )
        if not isinstance(handle, str) or _HANDLE.fullmatch(handle) is None:
            raise _provider_error(
                'output_handle_invalid',
                'Swift output handle is invalid',
                422,
            )
        with self._handle_lock:
            record = self._handles.get(handle)
        if record is None:
            raise _provider_error(
                'output_handle_stale',
                'Swift output handle is stale or unknown',
                409,
            )
        context = self._contexts.artifact_context(record.provider_session_id)
        if (
            context.provider_generation != record.provider_generation
            or context.provider_session_id != record.provider_session_id
        ):
            raise _provider_error(
                'output_handle_stale',
                'Swift output handle belongs to another Provider generation',
                409,
            )
        _, output_descriptor = _output_root(context)
        try:
            try:
                current = self._snapshot_candidate(
                    context,
                    output_descriptor,
                    record.snapshot.relative_path,
                )
            except ProviderError as exc:
                raise _provider_error(
                    'output_snapshot_changed',
                    'Swift output candidate changed after discovery',
                    409,
                ) from exc
            if current != record.snapshot:
                raise _provider_error(
                    'output_snapshot_changed',
                    'Swift output candidate changed after discovery',
                    409,
                )
            return self._write_archive(
                context,
                output_descriptor,
                current,
                destination,
                max_archive_bytes=max_archive_bytes,
            )
        finally:
            os.close(output_descriptor)

    def _candidate_paths(self, output_descriptor: int) -> tuple[str, ...]:
        remaining = self._limits.max_scan_entries

        def names(descriptor: int) -> list[str]:
            nonlocal remaining
            current = _bounded_names(descriptor, remaining)
            remaining -= len(current)
            return current

        candidates: list[str] = []
        for direct_name in names(output_descriptor):
            metadata = _stat_at(output_descriptor, direct_name)
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                continue
            direct = _open_child_directory(output_descriptor, direct_name)
            try:
                direct_names = names(direct)
                if 'adapter_config.json' in direct_names:
                    candidates.append(direct_name)
                    if len(candidates) > self._limits.max_candidates:
                        raise _provider_error(
                            'output_discovery_limit_exceeded',
                            'Swift output exceeds the candidate bound',
                            413,
                        )
                else:
                    for nested_name in direct_names:
                        nested_metadata = _stat_at(direct, nested_name)
                        if (
                            stat.S_ISLNK(nested_metadata.st_mode)
                            or not stat.S_ISDIR(nested_metadata.st_mode)
                        ):
                            continue
                        nested = _open_child_directory(direct, nested_name)
                        try:
                            if 'adapter_config.json' in names(nested):
                                candidates.append(f'{direct_name}/{nested_name}')
                        finally:
                            os.close(nested)
                        if len(candidates) > self._limits.max_candidates:
                            raise _provider_error(
                                'output_discovery_limit_exceeded',
                                'Swift output exceeds the candidate bound',
                                413,
                            )
            finally:
                os.close(direct)
        return tuple(sorted(candidates, key=lambda item: item.encode('utf-8')))

    def _snapshot_candidate(
        self,
        context: ArtifactSessionContext,
        output_descriptor: int,
        relative_path: str,
    ) -> _CandidateSnapshot:
        candidate = _open_candidate(output_descriptor, relative_path)
        try:
            directory_metadata = os.fstat(candidate)
            names = _bounded_names(candidate, self._limits.max_files)
            if 'adapter_config.json' not in names:
                raise _provider_error(
                    'output_snapshot_changed',
                    'Swift output candidate no longer contains adapter metadata',
                )
            files: list[_FileSnapshot] = []
            json_payloads: dict[str, Any] = {}
            total_bytes = 0
            for name in names:
                role = _allowed_role(name)
                if role is None:
                    raise _provider_error(
                        'output_candidate_unknown_file',
                        'LoRA output contains a file outside the strict allowlist',
                    )
                metadata = _stat_at(candidate, name)
                if role == 'excluded':
                    _validate_regular_file_metadata(metadata, self._limits.max_file_bytes)
                    total_bytes += metadata.st_size
                    if total_bytes > self._limits.max_total_bytes:
                        raise _provider_error(
                            'output_candidate_too_large',
                            'LoRA output exceeds the total byte bound',
                            413,
                        )
                    continue
                collect_limit: int | None = None
                if name == 'args.json':
                    collect_limit = self._limits.max_args_bytes
                elif name in _JSON_FILES or name == 'adapter_model.safetensors.index.json':
                    collect_limit = self._limits.max_json_bytes
                snapshot, collected = _read_snapshot_file(
                    candidate,
                    name,
                    metadata,
                    maximum_bytes=self._limits.max_file_bytes,
                    collect_bytes=collect_limit,
                )
                total_bytes += snapshot.size_bytes
                if total_bytes > self._limits.max_total_bytes:
                    raise _provider_error(
                        'output_candidate_too_large',
                        'LoRA output exceeds the total byte bound',
                        413,
                    )
                if (
                    name == 'adapter_config.json'
                    or name == 'args.json'
                    or name == 'adapter_model.safetensors.index.json'
                    or name in _JSON_FILES
                ):
                    assert collected is not None
                    json_payloads[name] = _json_without_duplicates(
                        collected,
                        'output_candidate_metadata_invalid',
                    )
                files.append(snapshot)

            file_names = set(names)
            adapter_config = json_payloads.get('adapter_config.json')
            if not isinstance(adapter_config, dict):
                raise _provider_error(
                    'output_candidate_adapter_config_invalid',
                    'LoRA adapter_config.json must be an object',
                )
            _reject_sensitive_adapter_config(adapter_config)
            additional_config = json_payloads.get('additional_config.json')
            if additional_config is not None:
                _validate_additional_adapter_config(additional_config)
            args = json_payloads.get('args.json', {})
            if not isinstance(args, dict):
                raise _provider_error(
                    'output_candidate_args_invalid',
                    'LoRA args.json must be an object when present',
                )
            weights = [
                item
                for item in files
                if item.path == 'adapter_model.safetensors'
                or _SHARD.fullmatch(item.path)
            ]
            inspected_weights = {
                item.path: _inspect_safetensors(
                    candidate,
                    item,
                    maximum_header_bytes=self._limits.max_json_bytes,
                )
                for item in weights
            }
            _validate_shards(
                file_names,
                json_payloads.get('adapter_model.safetensors.index.json'),
                inspected_weights,
            )
            archive_files = tuple(
                sorted(
                    (item for item in files if item.archived),
                    key=lambda item: item.path.encode('utf-8'),
                )
            )
            return _CandidateSnapshot(
                relative_path=relative_path,
                directory_device=directory_metadata.st_dev,
                directory_inode=directory_metadata.st_ino,
                directory_modified_at_ns=directory_metadata.st_mtime_ns,
                files=tuple(
                    sorted(files, key=lambda item: item.path.encode('utf-8'))
                ),
                archive_size_bytes=sum(item.size_bytes for item in archive_files),
                modified_at_ns=max(
                    [directory_metadata.st_mtime_ns]
                    + [item.modified_at_ns for item in files]
                ),
                sanitized_metadata=_sanitize_metadata(context, adapter_config, args),
            )
        finally:
            os.close(candidate)

    def _store_handle(
        self,
        context: ArtifactSessionContext,
        snapshot: _CandidateSnapshot,
    ) -> str:
        with self._handle_lock:
            while True:
                handle = f'swo_{self._token_factory(32)}'
                if _HANDLE.fullmatch(handle) is not None and handle not in self._handles:
                    break
            self._handles[handle] = _HandleRecord(
                provider_generation=context.provider_generation,
                provider_session_id=context.provider_session_id,
                snapshot=snapshot,
            )
            while len(self._handles) > self._limits.max_handles:
                self._handles.popitem(last=False)
            return handle

    def _write_archive(
        self,
        context: ArtifactSessionContext,
        output_descriptor: int,
        snapshot: _CandidateSnapshot,
        destination: Path,
        *,
        max_archive_bytes: int | None,
    ) -> ArtifactBuildResult:
        if destination.name in {'', '.', '..'} or destination.suffixes[-2:] != ['.tar', '.zst']:
            raise _provider_error(
                'artifact_destination_invalid',
                'Artifact destination must use the .tar.zst suffix',
                422,
            )
        parent = destination.parent
        try:
            parent_metadata = parent.lstat()
        except FileNotFoundError as exc:
            raise _provider_error(
                'artifact_destination_invalid',
                'Artifact destination directory does not exist',
                422,
            ) from exc
        if stat.S_ISLNK(parent_metadata.st_mode) or not stat.S_ISDIR(parent_metadata.st_mode):
            raise _provider_error(
                'artifact_destination_invalid',
                'Artifact destination directory is invalid',
                422,
            )
        if destination.exists() or destination.is_symlink():
            raise _provider_error(
                'artifact_destination_exists',
                'Artifact destination already exists',
                409,
            )
        partial = parent / f'.{destination.name}.{secrets.token_urlsafe(12)}.partial'
        descriptor: int | None = None
        try:
            descriptor = os.open(
                partial,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | getattr(os, 'O_NOFOLLOW', 0),
                0o600,
            )
            with os.fdopen(descriptor, 'wb', closefd=True) as raw:
                descriptor = None
                digest_writer = _DigestWriter(raw, max_archive_bytes)
                compressor = zstandard.ZstdCompressor(
                    level=_ZSTD_LEVEL,
                    threads=0,
                    write_checksum=True,
                    write_content_size=False,
                    write_dict_id=False,
                )
                candidate = _open_candidate(output_descriptor, snapshot.relative_path)
                try:
                    with compressor.stream_writer(
                        digest_writer,
                        closefd=False,
                    ) as compressed:
                        with tarfile.open(
                            fileobj=compressed,
                            mode='w|',
                            format=tarfile.USTAR_FORMAT,
                        ) as archive:
                            for file_snapshot in snapshot.files:
                                if not file_snapshot.archived:
                                    continue
                                file_descriptor = os.open(
                                    file_snapshot.path,
                                    os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0),
                                    dir_fd=candidate,
                                )
                                try:
                                    reader = _SnapshotReader(
                                        file_descriptor,
                                        file_snapshot,
                                    )
                                except Exception:
                                    os.close(file_descriptor)
                                    raise
                                try:
                                    info = tarfile.TarInfo(file_snapshot.path)
                                    info.size = file_snapshot.size_bytes
                                    info.mode = _ARCHIVE_MODE
                                    info.mtime = 0
                                    info.uid = 0
                                    info.gid = 0
                                    info.uname = ''
                                    info.gname = ''
                                    archive.addfile(info, reader)
                                    reader.verify()
                                finally:
                                    reader.close()
                finally:
                    os.close(candidate)
                raw.flush()
                os.fsync(raw.fileno())
                os.fchmod(raw.fileno(), 0o440)
                archive_digest = digest_writer.hasher.hexdigest()
                archive_size_bytes = digest_writer.size

            final_snapshot = self._snapshot_candidate(
                context,
                output_descriptor,
                snapshot.relative_path,
            )
            if final_snapshot != snapshot:
                raise _provider_error(
                    'output_snapshot_changed',
                    'Swift output candidate changed during archive construction',
                )
            try:
                os.link(partial, destination, follow_symlinks=False)
            except FileExistsError as exc:
                raise _provider_error(
                    'artifact_destination_exists',
                    'Artifact destination already exists',
                    409,
                ) from exc
            _fsync_directory(parent)
            partial.unlink()
            _fsync_directory(parent)

            file_manifest = [
                {
                    'path': item.path,
                    'digest_algorithm': 'blake3',
                    'digest': item.digest,
                    'size_bytes': item.size_bytes,
                }
                for item in snapshot.files
                if item.archived
            ]
            sanitized_metadata = dict(snapshot.sanitized_metadata)
            lineage = sanitized_metadata.get('dataset_lineage')
            if (
                isinstance(lineage, dict)
                and lineage.get('status') == 'verified'
                and not _exact_dataset_export_matches(context)
            ):
                sanitized_metadata['dataset_lineage'] = {
                    'status': 'external_or_unverified',
                    'dataset_version': None,
                    'dataset_export_digest': None,
                }
            provider_metadata = {
                **sanitized_metadata,
                'archive_digest_algorithm': 'blake3',
                'archive_digest': archive_digest,
                'archive_size_bytes': archive_size_bytes,
                'output_snapshot_digest': _output_snapshot_digest(snapshot),
                'files': file_manifest,
            }
            return ArtifactBuildResult(
                archive_digest=archive_digest,
                archive_size_bytes=archive_size_bytes,
                provider_metadata=provider_metadata,
            )
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                partial.unlink()
            except FileNotFoundError:
                pass
