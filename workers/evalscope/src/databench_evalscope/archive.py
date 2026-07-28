"""Deterministic, allowlisted EvalScope result archives."""

from __future__ import annotations

import json
import os
import re
import stat
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

import blake3
import zstandard

from .config import EVALSCOPE_COMMIT
from .errors import RuntimePolicyError

_ALLOWED_ROOT_FILES = {'progress.json', 'databench-result-manifest.json'}
_ALLOWED_DIRECTORIES = {'reports', 'reviews', 'predictions'}
_STRUCTURED_SUFFIXES = {'.json', '.jsonl', '.yaml', '.yml'}
_CREDENTIAL_KEY = re.compile(
    r'^(?:authorization|proxy[_-]?authorization|api[_-]?key|access[_-]?key|secret|password|token|cookie|headers?)$',
    re.IGNORECASE,
)
_CREDENTIAL_VALUE = re.compile(
    r'(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token|password|secret)\s*[:=]\s*\S+)',
    re.IGNORECASE,
)
_YAML_CREDENTIAL = re.compile(
    r'^\s*(?:authorization|proxy_authorization|api[_-]?key|access[_-]?key|secret|password|token|cookie|headers?)\s*:',
    re.IGNORECASE | re.MULTILINE,
)


@dataclass(frozen=True)
class ResultArchive:
    path: Path
    digest: str
    size: int

    def cleanup(self) -> None:
        self.path.unlink(missing_ok=True)


def package_result_archive(
    task_dir: Path,
    *,
    task_id: str,
    run_id: str,
    provider_report_ids: list[str],
    max_bytes: int,
) -> ResultArchive:
    """Create stable tar.zst bytes without following any filesystem link."""
    root = task_dir.resolve(strict=False)
    root_stat = task_dir.lstat()
    if not stat.S_ISDIR(root_stat.st_mode) or task_dir.is_symlink():
        raise _policy('archive_path_invalid', 'Evaluation task output directory is invalid')
    manifest = {
        'archive_format': 'evaluation-result-v1',
        'evalscope_commit': EVALSCOPE_COMMIT,
        'provider': 'evalscope',
        'provider_report_ids': provider_report_ids,
        'run_id': run_id,
        'schema_version': 1,
        'task_id': task_id,
    }
    manifest_path = task_dir / 'databench-result-manifest.json'
    _write_manifest(manifest_path, manifest)
    entries = _collect_entries(task_dir, root, max_bytes)
    fd, raw_path = tempfile.mkstemp(
        dir=task_dir,
        prefix='.databench-result-',
        suffix='.tar.zst',
    )
    archive_path = Path(raw_path)
    try:
        with os.fdopen(fd, 'wb', closefd=True) as destination:
            compressor = zstandard.ZstdCompressor(
                level=10,
                threads=0,
                write_checksum=True,
                write_content_size=False,
            )
            with compressor.stream_writer(destination, closefd=False) as compressed:
                with tarfile.open(
                    fileobj=compressed,
                    mode='w|',
                    format=tarfile.GNU_FORMAT,
                ) as archive:
                    for relative, path, metadata in entries:
                        _add_regular_file(archive, relative, path, metadata)
            destination.flush()
            os.fsync(destination.fileno())
        size = archive_path.stat().st_size
        if size <= 0 or size > max_bytes:
            raise _policy('archive_too_large', 'Evaluation result archive exceeds its byte limit')
        hasher = blake3.blake3()
        with archive_path.open('rb') as source:
            while chunk := source.read(1024 * 1024):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        return ResultArchive(path=archive_path, digest=digest, size=size)
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise


def _collect_entries(
    task_dir: Path,
    resolved_root: Path,
    max_bytes: int,
) -> list[tuple[str, Path, os.stat_result]]:
    entries: list[tuple[str, Path, os.stat_result]] = []
    total = 0
    candidates: list[Path] = []
    for name in sorted(_ALLOWED_ROOT_FILES):
        path = task_dir / name
        if path.exists() or path.is_symlink():
            candidates.append(path)
    for name in sorted(_ALLOWED_DIRECTORIES):
        directory = task_dir / name
        if not directory.exists() and not directory.is_symlink():
            continue
        directory_stat = directory.lstat()
        if not stat.S_ISDIR(directory_stat.st_mode) or directory.is_symlink():
            raise _policy('archive_file_invalid', 'Evaluation archive contains an invalid directory')
        for current_root, directories, files in os.walk(directory, followlinks=False):
            current = Path(current_root)
            for child_name in directories:
                child = current / child_name
                child_stat = child.lstat()
                if not stat.S_ISDIR(child_stat.st_mode) or child.is_symlink():
                    raise _policy('archive_file_invalid', 'Evaluation archive cannot contain links')
            for child_name in files:
                candidates.append(current / child_name)
    for path in candidates:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or metadata.st_nlink != 1:
            raise _policy('archive_file_invalid', 'Evaluation archive accepts only regular files')
        resolved = path.resolve(strict=True)
        if resolved_root not in resolved.parents:
            raise _policy('archive_path_invalid', 'Evaluation archive path escaped its task directory')
        relative = path.relative_to(task_dir).as_posix()
        if relative.startswith('/') or '..' in Path(relative).parts:
            raise _policy('archive_path_invalid', 'Evaluation archive path is invalid')
        if not _allowed_relative(relative):
            raise _policy('archive_path_invalid', 'Evaluation archive path is not allowlisted')
        total += metadata.st_size
        if total > max_bytes:
            raise _policy('archive_too_large', 'Evaluation result files exceed the archive byte limit')
        if path.suffix.lower() in _STRUCTURED_SUFFIXES:
            _scan_structured(path, metadata.st_size)
        entries.append((relative, path, metadata))
    entries.sort(key=lambda item: item[0].encode('utf-8'))
    return entries


def _allowed_relative(relative: str) -> bool:
    if relative in _ALLOWED_ROOT_FILES:
        return True
    first = relative.split('/', 1)[0]
    return first in _ALLOWED_DIRECTORIES and '/' in relative


def _scan_structured(path: Path, expected_size: int) -> None:
    raw = _read_exact(path, expected_size)
    if len(raw) > 16 * 1024 * 1024:
        raise _policy('archive_file_invalid', 'Structured archive file exceeds the scan limit')
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise _policy('archive_file_invalid', 'Structured archive file is not UTF-8') from exc
    suffix = path.suffix.lower()
    if suffix == '.json':
        try:
            _scan_value(json.loads(text))
        except json.JSONDecodeError as exc:
            raise _policy('archive_file_invalid', 'Structured archive JSON is malformed') from exc
    elif suffix == '.jsonl':
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                _scan_value(json.loads(line))
            except json.JSONDecodeError as exc:
                raise _policy('archive_file_invalid', 'Structured archive JSONL is malformed') from exc
    elif _YAML_CREDENTIAL.search(text) or _CREDENTIAL_VALUE.search(text):
        raise _policy('archive_secret_detected', 'Credential-like data is not allowed in result archives')


def _scan_value(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or _CREDENTIAL_KEY.search(key):
                raise _policy(
                    'archive_secret_detected',
                    'Credential-like keys are not allowed in result archives',
                )
            _scan_value(child)
    elif isinstance(value, list):
        for child in value:
            _scan_value(child)
    elif isinstance(value, str) and _CREDENTIAL_VALUE.search(value):
        raise _policy(
            'archive_secret_detected',
            'Credential-like values are not allowed in result archives',
        )


def _add_regular_file(
    archive: tarfile.TarFile,
    relative: str,
    path: Path,
    expected: os.stat_result,
) -> None:
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        actual = os.fstat(fd)
        if (
            not stat.S_ISREG(actual.st_mode)
            or actual.st_nlink != 1
            or actual.st_dev != expected.st_dev
            or actual.st_ino != expected.st_ino
            or actual.st_size != expected.st_size
        ):
            raise _policy('archive_file_invalid', 'Evaluation result changed while packaging')
        info = tarfile.TarInfo(relative)
        info.size = actual.st_size
        info.mode = 0o640
        info.mtime = 0
        info.uid = 0
        info.gid = 0
        info.uname = ''
        info.gname = ''
        with os.fdopen(os.dup(fd), 'rb', closefd=True) as source:
            archive.addfile(info, source)
    finally:
        os.close(fd)


def _read_exact(path: Path, expected_size: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        raw = os.read(fd, expected_size + 1)
        if len(raw) != expected_size:
            raise _policy('archive_file_invalid', 'Structured result file changed while scanning')
        return raw
    finally:
        os.close(fd)


def _write_manifest(path: Path, value: dict[str, Any]) -> None:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8') + b'\n'
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.partial')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(temporary, flags, 0o640)
    try:
        _write_all(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)


def _policy(code: str, message: str) -> RuntimePolicyError:
    status_code = 413 if code == 'archive_too_large' else 422
    return RuntimePolicyError(code, message, status_code)


def _write_all(fd: int, raw: bytes) -> None:
    offset = 0
    while offset < len(raw):
        written = os.write(fd, raw[offset:])
        if written <= 0:
            raise OSError('short write')
        offset += written
