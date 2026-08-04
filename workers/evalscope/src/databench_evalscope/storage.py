"""Crash-safe task claims, terminal evidence, and reconciliation."""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

import rfc8785

from .errors import RuntimePolicyError
from .security import validate_task_id

_DIGEST = re.compile(r'^[0-9a-f]{64}$')
_RUN_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
_EXACT_VERSION = re.compile(r'^[0-9a-f]{64}$')
_SAFE_TOKEN = re.compile(r'^[a-z][a-z0-9._-]{0,127}$')
_PROVIDER_REPORT_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$')
_CREDENTIAL = re.compile(
    r'(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token|password|secret)\s*[:=]\s*\S+)',
    re.IGNORECASE,
)
_CLAIM_FILE = 'task-claim.json'
_INTEGRATION_FILE = 'databench-integration.json'
_MAX_MANIFEST_BYTES = 64 * 1024

TaskKind = Literal['evaluation', 'performance']
TaskPhase = Literal['preparing', 'running', 'completed', 'failed', 'cancelled']
TerminalStatus = Literal['completed', 'failed', 'cancelled']
ClaimDisposition = Literal['created', 'already_running', 'terminal_replay']


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def config_digest(config: Any, key: bytes) -> str:
    try:
        canonical = rfc8785.dumps(config)
    except (TypeError, ValueError) as exc:
        raise RuntimePolicyError(
            'task_config_invalid',
            'Task configuration cannot be canonicalized',
            422,
        ) from exc
    return hmac.new(key, canonical, hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class ClaimResult:
    disposition: ClaimDisposition
    manifest: dict[str, Any]


@dataclass(frozen=True)
class ReconcileResult:
    scanned: int
    terminal_replayed: int
    cancelled: int
    interrupted: int
    quarantined: int
    callback_failures: int


Callback = Callable[[dict[str, Any], dict[str, Any]], bool]


class TaskManifestStore:
    def __init__(self, output_root: Path, *, max_tasks: int = 10_000) -> None:
        self._root = output_root.resolve(strict=False)
        self._max_tasks = max_tasks
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        self._capacity_lock = threading.Lock()

    def has_claim(self, task_id: str) -> bool:
        validate_task_id(task_id)
        with self._task_lock(task_id):
            task_dir = self._root / task_id
            try:
                task_stat = task_dir.lstat()
            except FileNotFoundError:
                return False
            if not task_dir.is_dir() or task_dir.is_symlink() or task_stat.st_nlink < 2:
                raise RuntimePolicyError('task_storage_invalid', 'Task storage is invalid', 500)

            claim_path = task_dir / _CLAIM_FILE
            try:
                claim_stat = claim_path.lstat()
            except FileNotFoundError:
                return False
            if claim_path.is_symlink() or not claim_path.is_file() or claim_stat.st_nlink != 1:
                raise RuntimePolicyError('task_storage_invalid', 'Task claim storage is invalid', 500)
            return True

    def claim(self, task_id: str, task_kind: TaskKind, digest: str) -> ClaimResult:
        validate_task_id(task_id)
        if not _DIGEST.fullmatch(digest):
            raise RuntimePolicyError('task_config_invalid', 'Task config digest is invalid', 500)
        if (task_kind == 'evaluation') != task_id.startswith('eval_'):
            raise RuntimePolicyError('invalid_task_id', 'Task ID prefix does not match task kind', 400)
        with self._capacity_lock, self._task_lock(task_id):
            candidate = self._root / task_id
            if not candidate.exists() and len(self._task_directories()) >= self._max_tasks:
                raise RuntimePolicyError('task_capacity_exceeded', 'Task storage capacity is exhausted', 503)
            task_dir = self._task_dir(task_id, create=True)
            path = task_dir / _CLAIM_FILE
            now = utc_now()
            manifest = {
                'schema_version': 1,
                'task_id': task_id,
                'task_kind': task_kind,
                'config_digest': digest,
                'phase': 'preparing',
                'created_at': now,
                'updated_at': now,
                'stop_requested_at': None,
                'terminal': None,
                'callback_confirmed': False,
            }
            try:
                self._exclusive_write(path, manifest)
                return ClaimResult('created', copy.deepcopy(manifest))
            except FileExistsError:
                existing = self._read_manifest(path)
                if not hmac.compare_digest(existing['config_digest'], digest):
                    raise RuntimePolicyError(
                        'task_id_conflict',
                        'Task ID is already bound to a different configuration',
                        409,
                    )
                if existing['phase'] in {'completed', 'failed', 'cancelled'}:
                    return ClaimResult('terminal_replay', existing)
                return ClaimResult('already_running', existing)

    def read(self, task_id: str) -> dict[str, Any]:
        validate_task_id(task_id)
        with self._task_lock(task_id):
            return self._read_manifest(self._task_dir(task_id) / _CLAIM_FILE)

    def mark_running(self, task_id: str) -> dict[str, Any]:
        def mutate(manifest: dict[str, Any]) -> None:
            if manifest['phase'] not in {'preparing', 'running'}:
                raise RuntimePolicyError('task_state_conflict', 'Task is already terminal', 409)
            manifest['phase'] = 'running'

        return self._update(task_id, mutate)

    def request_stop(self, task_id: str) -> dict[str, Any]:
        def mutate(manifest: dict[str, Any]) -> None:
            if manifest['phase'] in {'completed', 'failed', 'cancelled'}:
                return
            if manifest['stop_requested_at'] is None:
                manifest['stop_requested_at'] = utc_now()

        return self._update(task_id, mutate)

    def record_terminal(
        self,
        task_id: str,
        status: TerminalStatus,
        *,
        metrics: list[dict[str, Any]] | None = None,
        provider_report_ids: list[str] | None = None,
        error: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        def mutate(manifest: dict[str, Any]) -> None:
            final_status: TerminalStatus = 'cancelled' if manifest['stop_requested_at'] else status
            terminal = _terminal_envelope(
                final_status,
                metrics=metrics,
                provider_report_ids=provider_report_ids,
                error=None if final_status == 'cancelled' else error,
            )
            if manifest['terminal'] is not None:
                if manifest['terminal'] != terminal:
                    raise RuntimePolicyError(
                        'task_terminal_conflict',
                        'Task already has different terminal evidence',
                        409,
                    )
                return
            manifest['phase'] = final_status
            manifest['terminal'] = terminal
            manifest['callback_confirmed'] = False

        return self._update(task_id, mutate)

    def confirm_callback(self, task_id: str) -> dict[str, Any]:
        def mutate(manifest: dict[str, Any]) -> None:
            if manifest['terminal'] is None:
                raise RuntimePolicyError('task_state_conflict', 'Task is not terminal', 409)
            manifest['callback_confirmed'] = True

        return self._update(task_id, mutate)

    def write_integration(self, task_id: str, integration: dict[str, Any]) -> dict[str, Any]:
        validate_task_id(task_id)
        normalized = _validate_integration(integration)
        if normalized['task_id'] != task_id:
            raise RuntimePolicyError('task_integration_invalid', 'Task integration ID does not match', 500)
        with self._task_lock(task_id):
            path = self._task_dir(task_id) / _INTEGRATION_FILE
            if path.exists():
                existing = self._read_json(path, _MAX_MANIFEST_BYTES)
                if existing != normalized:
                    raise RuntimePolicyError(
                        'task_integration_conflict',
                        'Task integration locator already differs',
                        409,
                    )
                return existing
            self._exclusive_write(path, normalized)
            return copy.deepcopy(normalized)

    def update_integration(self, task_id: str, update: dict[str, Any]) -> dict[str, Any]:
        validate_task_id(task_id)
        with self._task_lock(task_id):
            path = self._task_dir(task_id) / _INTEGRATION_FILE
            current = self._read_json(path, _MAX_MANIFEST_BYTES)
            current.update(update)
            normalized = _validate_integration(current)
            if normalized['task_id'] != task_id:
                raise RuntimePolicyError('task_integration_invalid', 'Task integration ID does not match', 500)
            self._atomic_write(path, normalized)
            return copy.deepcopy(normalized)

    def read_integration(self, task_id: str) -> dict[str, Any] | None:
        validate_task_id(task_id)
        with self._task_lock(task_id):
            path = self._task_dir(task_id) / _INTEGRATION_FILE
            if not path.exists():
                return None
            integration = _validate_integration(self._read_json(path, _MAX_MANIFEST_BYTES))
            if integration['task_id'] != task_id:
                raise RuntimePolicyError('task_integration_invalid', 'Task integration ID does not match', 500)
            return integration

    def reconcile_all(self, callback: Callback) -> ReconcileResult:
        counts = {
            'scanned': 0,
            'terminal_replayed': 0,
            'cancelled': 0,
            'interrupted': 0,
            'quarantined': 0,
            'callback_failures': 0,
        }
        for path in self._task_directories():
            task_id = path.name
            counts['scanned'] += 1
            try:
                manifest = self.read(task_id)
                if manifest['phase'] in {'completed', 'failed', 'cancelled'}:
                    counts['terminal_replayed'] += 1
                elif manifest['stop_requested_at'] is not None:
                    manifest = self.record_terminal(task_id, 'cancelled')
                    counts['cancelled'] += 1
                else:
                    manifest = self.record_terminal(
                        task_id,
                        'failed',
                        error={
                            'phase': 'provider_reconcile',
                            'code': 'provider_interrupted',
                            'message': 'EvalScope process was interrupted before terminal evidence',
                        },
                    )
                    counts['interrupted'] += 1
                integration = self.read_integration(task_id)
                if integration is not None and not manifest['callback_confirmed']:
                    if callback(manifest, integration):
                        self.confirm_callback(task_id)
                    else:
                        counts['callback_failures'] += 1
            except Exception:
                self._quarantine_manifest(path)
                counts['quarantined'] += 1
        return ReconcileResult(**counts)

    def reconcile_one(self, task_id: str, callback: Callback) -> dict[str, Any]:
        validate_task_id(task_id)
        manifest = self.read(task_id)
        if manifest['phase'] not in {'completed', 'failed', 'cancelled'}:
            if manifest['stop_requested_at'] is not None:
                manifest = self.record_terminal(task_id, 'cancelled')
            else:
                manifest = self.record_terminal(
                    task_id,
                    'failed',
                    error={
                        'phase': 'provider_reconcile',
                        'code': 'provider_interrupted',
                        'message': 'EvalScope process was interrupted before terminal evidence',
                    },
                )
        integration = self.read_integration(task_id)
        if integration is not None and not manifest['callback_confirmed']:
            if not callback(manifest, integration):
                raise RuntimePolicyError(
                    'databench_callback_unavailable',
                    'Databench callback could not be confirmed',
                    503,
                )
            manifest = self.confirm_callback(task_id)
        return manifest

    def _update(self, task_id: str, mutate: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        validate_task_id(task_id)
        with self._task_lock(task_id):
            path = self._task_dir(task_id) / _CLAIM_FILE
            manifest = self._read_manifest(path)
            mutate(manifest)
            manifest['updated_at'] = utc_now()
            normalized = _validate_manifest(manifest)
            self._atomic_write(path, normalized)
            return copy.deepcopy(normalized)

    def _task_lock(self, task_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks.setdefault(task_id, threading.RLock())

    def _task_dir(self, task_id: str, *, create: bool = False) -> Path:
        validate_task_id(task_id)
        path = self._root / task_id
        if create:
            try:
                path.mkdir(mode=0o750)
                self._fsync_directory(self._root)
            except FileExistsError:
                pass
        try:
            stat = path.lstat()
        except FileNotFoundError as exc:
            raise RuntimePolicyError('task_not_found', 'Task claim was not found', 404) from exc
        if not path.is_dir() or path.is_symlink() or stat.st_nlink < 2:
            raise RuntimePolicyError('task_storage_invalid', 'Task storage is invalid', 500)
        return path

    def _task_directories(self) -> tuple[Path, ...]:
        paths: list[Path] = []
        for path in sorted(self._root.iterdir(), key=lambda item: item.name):
            if len(paths) >= self._max_tasks:
                break
            if path.is_symlink() or not path.is_dir() or not path.name.startswith(('eval_', 'perf_')):
                continue
            paths.append(path)
        return tuple(paths)

    def _read_manifest(self, path: Path) -> dict[str, Any]:
        return _validate_manifest(self._read_json(path, _MAX_MANIFEST_BYTES))

    @staticmethod
    def _read_json(path: Path, max_bytes: int) -> dict[str, Any]:
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(path, flags)
        try:
            stat = os.fstat(fd)
            if stat.st_size <= 0 or stat.st_size > max_bytes or stat.st_nlink != 1:
                raise RuntimePolicyError('task_manifest_invalid', 'Task manifest size is invalid', 500)
            raw = os.read(fd, max_bytes + 1)
            if len(raw) != stat.st_size:
                raise RuntimePolicyError('task_manifest_invalid', 'Task manifest changed while reading', 500)
        finally:
            os.close(fd)
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimePolicyError('task_manifest_invalid', 'Task manifest is malformed', 500) from exc
        if not isinstance(value, dict):
            raise RuntimePolicyError('task_manifest_invalid', 'Task manifest must be an object', 500)
        return value

    def _exclusive_write(self, path: Path, value: dict[str, Any]) -> None:
        raw = _json_bytes(value)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(path, flags, 0o600)
        try:
            _write_all(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        self._fsync_directory(path.parent)

    def _atomic_write(self, path: Path, value: dict[str, Any]) -> None:
        raw = _json_bytes(value)
        temp = path.parent / f'.{path.name}.{uuid.uuid4().hex}.tmp'
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(temp, flags, 0o600)
        try:
            _write_all(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, path)
        self._fsync_directory(path.parent)

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _quarantine_manifest(self, task_dir: Path) -> None:
        source = task_dir / _CLAIM_FILE
        if not source.exists() or source.is_symlink():
            return
        destination = task_dir / f'{_CLAIM_FILE}.invalid.{uuid.uuid4().hex}'
        os.replace(source, destination)
        self._fsync_directory(task_dir)


def _write_all(fd: int, raw: bytes) -> None:
    offset = 0
    while offset < len(raw):
        offset += os.write(fd, raw[offset:])


def _json_bytes(value: dict[str, Any]) -> bytes:
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')
    if not raw or len(raw) > _MAX_MANIFEST_BYTES:
        raise RuntimePolicyError('task_manifest_invalid', 'Task manifest exceeds its byte bound', 500)
    return raw


def _terminal_envelope(
    status: TerminalStatus,
    *,
    metrics: list[dict[str, Any]] | None,
    provider_report_ids: list[str] | None,
    error: dict[str, str] | None,
) -> dict[str, Any]:
    if status == 'completed':
        terminal = {
            'status': status,
            'metrics': metrics or [],
            'provider_report_ids': provider_report_ids or [],
            'error': None,
        }
    else:
        terminal = {
            'status': status,
            'metrics': None,
            'provider_report_ids': None,
            'error': error
            or {
                'phase': 'provider_stop' if status == 'cancelled' else 'provider_run',
                'code': 'user_cancelled' if status == 'cancelled' else 'provider_failed',
                'message': 'Task was cancelled' if status == 'cancelled' else 'EvalScope task failed',
            },
        }
    raw = json.dumps(terminal, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > 32 * 1024:
        raise RuntimePolicyError('task_terminal_invalid', 'Terminal task summary exceeds its byte bound', 500)
    return terminal


def _validate_manifest(value: dict[str, Any]) -> dict[str, Any]:
    required = {
        'schema_version',
        'task_id',
        'task_kind',
        'config_digest',
        'phase',
        'created_at',
        'updated_at',
        'stop_requested_at',
        'terminal',
        'callback_confirmed',
    }
    if set(value) != required or value.get('schema_version') != 1:
        raise RuntimePolicyError('task_manifest_invalid', 'Task manifest fields are invalid', 500)
    task_id = validate_task_id(value.get('task_id'))
    task_kind = value.get('task_kind')
    if task_kind not in {'evaluation', 'performance'} or (task_kind == 'evaluation') != task_id.startswith('eval_'):
        raise RuntimePolicyError('task_manifest_invalid', 'Task manifest kind is invalid', 500)
    if not isinstance(value.get('config_digest'), str) or not _DIGEST.fullmatch(value['config_digest']):
        raise RuntimePolicyError('task_manifest_invalid', 'Task manifest digest is invalid', 500)
    if value.get('phase') not in {'preparing', 'running', 'completed', 'failed', 'cancelled'}:
        raise RuntimePolicyError('task_manifest_invalid', 'Task manifest phase is invalid', 500)
    if not _valid_timestamp(value.get('created_at')) or not _valid_timestamp(value.get('updated_at')):
        raise RuntimePolicyError('task_manifest_invalid', 'Task manifest timestamps are invalid', 500)
    if value.get('stop_requested_at') is not None and not _valid_timestamp(value['stop_requested_at']):
        raise RuntimePolicyError('task_manifest_invalid', 'Task stop timestamp is invalid', 500)
    terminal = value.get('terminal')
    is_terminal = value['phase'] in {'completed', 'failed', 'cancelled'}
    if is_terminal != isinstance(terminal, dict):
        raise RuntimePolicyError('task_manifest_invalid', 'Task terminal evidence is invalid', 500)
    if terminal is not None and terminal.get('status') != value['phase']:
        raise RuntimePolicyError('task_manifest_invalid', 'Task terminal status is invalid', 500)
    if terminal is not None:
        _validate_terminal(terminal)
    if not isinstance(value.get('callback_confirmed'), bool):
        raise RuntimePolicyError('task_manifest_invalid', 'Task callback state is invalid', 500)
    return copy.deepcopy(value)


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 32 or not value.endswith('Z'):
        return False
    try:
        datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        return False
    return True


def _validate_terminal(value: dict[str, Any]) -> None:
    if set(value) != {'status', 'metrics', 'provider_report_ids', 'error'}:
        raise RuntimePolicyError('task_manifest_invalid', 'Task terminal fields are invalid', 500)
    status = value.get('status')
    if status == 'completed':
        metrics = value.get('metrics')
        report_ids = value.get('provider_report_ids')
        if value.get('error') is not None or not isinstance(metrics, list) or len(metrics) > 10_000:
            raise RuntimePolicyError('task_manifest_invalid', 'Task terminal metrics are invalid', 500)
        if not isinstance(report_ids, list) or len(report_ids) > 32 or len(set(report_ids)) != len(report_ids):
            raise RuntimePolicyError('task_manifest_invalid', 'Task terminal report IDs are invalid', 500)
        for metric in metrics:
            _validate_metric(metric)
        for report_id in report_ids:
            if (
                not isinstance(report_id, str)
                or not _PROVIDER_REPORT_ID.fullmatch(report_id)
                or _CREDENTIAL.search(report_id)
            ):
                raise RuntimePolicyError('task_manifest_invalid', 'Task terminal report ID is invalid', 500)
    elif status in {'failed', 'cancelled'}:
        if value.get('metrics') is not None or value.get('provider_report_ids') is not None:
            raise RuntimePolicyError('task_manifest_invalid', 'Task terminal failure fields are invalid', 500)
        _validate_error(value.get('error'))
    else:
        raise RuntimePolicyError('task_manifest_invalid', 'Task terminal status is invalid', 500)


def _validate_metric(value: Any) -> None:
    legacy_fields = {
        'dataset',
        'subset',
        'metric',
        'score',
        'sample_count',
        'categories',
    }
    metric_fields = legacy_fields | {'metric_id', 'output_key'}
    fields = set(value) if isinstance(value, dict) else set()
    if not isinstance(value, dict) or (fields != legacy_fields and fields != metric_fields):
        raise RuntimePolicyError('task_manifest_invalid', 'Task metric fields are invalid', 500)
    if fields == metric_fields:
        metric_id = value.get('metric_id')
        output_key = value.get('output_key')
        if (metric_id is None) != (output_key is None):
            raise RuntimePolicyError('task_manifest_invalid', 'Task Metric identity is invalid', 500)
        if metric_id is not None and (
            not isinstance(metric_id, str)
            or not _SAFE_TOKEN.fullmatch(metric_id)
            or not _bounded_text(output_key, 128)
        ):
            raise RuntimePolicyError('task_manifest_invalid', 'Task Metric identity is invalid', 500)
    for field, maximum in (('dataset', 512), ('metric', 512)):
        if not _bounded_text(value.get(field), maximum):
            raise RuntimePolicyError('task_manifest_invalid', 'Task metric text is invalid', 500)
    if value.get('subset') is not None and not _bounded_text(value['subset'], 512):
        raise RuntimePolicyError('task_manifest_invalid', 'Task metric subset is invalid', 500)
    score = value.get('score')
    if score is not None and (not isinstance(score, (int, float)) or isinstance(score, bool) or not _finite(score)):
        raise RuntimePolicyError('task_manifest_invalid', 'Task metric score is invalid', 500)
    count = value.get('sample_count')
    if count is not None and (not isinstance(count, int) or isinstance(count, bool) or count < 0 or count > 2**53 - 1):
        raise RuntimePolicyError('task_manifest_invalid', 'Task metric sample count is invalid', 500)
    categories = value.get('categories')
    if (
        not isinstance(categories, list)
        or len(categories) > 64
        or any(not isinstance(category, str) for category in categories)
        or len(set(categories)) != len(categories)
        or any(not _bounded_text(category, 128) for category in categories)
    ):
        raise RuntimePolicyError('task_manifest_invalid', 'Task metric categories are invalid', 500)


def _validate_error(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {'phase', 'code', 'message'}:
        raise RuntimePolicyError('task_manifest_invalid', 'Task terminal error is invalid', 500)
    if (
        not isinstance(value.get('phase'), str)
        or not _SAFE_TOKEN.fullmatch(value['phase'])
        or not isinstance(value.get('code'), str)
        or not _SAFE_TOKEN.fullmatch(value['code'])
        or not _bounded_text(value.get('message'), 2_048)
    ):
        raise RuntimePolicyError('task_manifest_invalid', 'Task terminal error is invalid', 500)


def _bounded_text(value: Any, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and len(value.encode('utf-8')) <= maximum
        and not _CREDENTIAL.search(value)
        and all(ord(character) >= 0x20 and ord(character) != 0x7f for character in value)
    )


def _finite(value: int | float) -> bool:
    return value == value and value not in {float('inf'), float('-inf')}


def _validate_integration(value: dict[str, Any]) -> dict[str, Any]:
    version = value.get('schema_version')
    common = {
        'schema_version',
        'task_id',
        'run_id',
        'source_ref',
        'dataset_version',
        'converter',
        'options',
        'accepted_fidelity_digest',
        'model_name',
        'evalscope_commit',
        'input_filename',
    }
    deployment_fields = {
        'model_deployment_id',
        'model_artifact_id',
        'model_deployment_digest',
    }
    scoring_fields = {'scoring_config'}
    model_version_fields = deployment_fields | {'model_id', 'model_version_id'}
    expected = (
        common
        if version == 1
        else common | deployment_fields
        if version == 2
        else common | scoring_fields
        if version == 3
        else common | deployment_fields | scoring_fields
        if version == 4
        else common | model_version_fields
        if version == 5
        else common | model_version_fields | scoring_fields
        if version == 6
        else set()
    )
    if set(value) != expected:
        raise RuntimePolicyError('task_integration_invalid', 'Task integration fields are invalid', 500)
    validate_task_id(value.get('task_id'))
    run_id = value.get('run_id')
    if run_id is not None and (not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id)):
        raise RuntimePolicyError('task_integration_invalid', 'Task integration run ID is invalid', 500)
    if not isinstance(value.get('dataset_version'), str) or not _EXACT_VERSION.fullmatch(value['dataset_version']):
        raise RuntimePolicyError('task_integration_invalid', 'Task integration Dataset version is invalid', 500)
    if not isinstance(value.get('accepted_fidelity_digest'), str) or not _EXACT_VERSION.fullmatch(
        value['accepted_fidelity_digest']
    ):
        raise RuntimePolicyError('task_integration_invalid', 'Task integration fidelity digest is invalid', 500)
    if value.get('converter') != 'evalscope-general-qa':
        raise RuntimePolicyError('task_integration_invalid', 'Task integration converter is invalid', 500)
    if value.get('evalscope_commit') != 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60':
        raise RuntimePolicyError('task_integration_invalid', 'Task integration commit is invalid', 500)
    options = value.get('options')
    if not isinstance(options, dict) or set(options) != {'target_source'} or options['target_source'] not in {
        'selected-candidate',
        'verification-ground-truth',
        'none',
    }:
        raise RuntimePolicyError('task_integration_invalid', 'Task integration options are invalid', 500)
    filename = value.get('input_filename')
    if filename != 'databench.jsonl':
        raise RuntimePolicyError('task_integration_invalid', 'Task integration filename is invalid', 500)
    for field in ('source_ref', 'model_name'):
        item = value.get(field)
        if item is not None and not _bounded_text(item, 512):
            raise RuntimePolicyError('task_integration_invalid', f'Task integration {field} is invalid', 500)
    if version in {2, 4}:
        for field in ('model_deployment_id', 'model_artifact_id'):
            item = value.get(field)
            if not isinstance(item, str) or not _RUN_ID.fullmatch(item):
                raise RuntimePolicyError(
                    'task_integration_invalid',
                    f'Task integration {field} is invalid',
                    500,
                )
        deployment_digest = value.get('model_deployment_digest')
        if not isinstance(deployment_digest, str) or not _EXACT_VERSION.fullmatch(deployment_digest):
            raise RuntimePolicyError(
                'task_integration_invalid',
                'Task integration Model Deployment digest is invalid',
                500,
            )
        if value.get('model_name') is None:
            raise RuntimePolicyError(
                'task_integration_invalid',
                'Task integration served model is invalid',
                500,
            )
    if version in {5, 6}:
        for field in ('model_id', 'model_version_id', 'model_deployment_id'):
            item = value.get(field)
            if not isinstance(item, str) or not _RUN_ID.fullmatch(item):
                raise RuntimePolicyError(
                    'task_integration_invalid',
                    f'Task integration {field} is invalid',
                    500,
                )
        artifact_id = value.get('model_artifact_id')
        if artifact_id is not None and (
            not isinstance(artifact_id, str) or not _RUN_ID.fullmatch(artifact_id)
        ):
            raise RuntimePolicyError(
                'task_integration_invalid',
                'Task integration model_artifact_id is invalid',
                500,
            )
        deployment_digest = value.get('model_deployment_digest')
        if not isinstance(deployment_digest, str) or not _EXACT_VERSION.fullmatch(
            deployment_digest
        ):
            raise RuntimePolicyError(
                'task_integration_invalid',
                'Task integration Model Deployment digest is invalid',
                500,
            )
        if value.get('model_name') is None:
            raise RuntimePolicyError(
                'task_integration_invalid',
                'Task integration served model is invalid',
                500,
            )
    if version in {3, 4, 6}:
        _validate_scoring_config(value.get('scoring_config'))
    return copy.deepcopy(value)


def _validate_scoring_config(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {
        'schema_version',
        'mode',
        'evalscope_commit',
        'benchmark',
        'metrics',
        'primary_metric_id',
        'primary_output_key',
    }:
        raise RuntimePolicyError('task_integration_invalid', 'Task scoring config is invalid', 500)
    if (
        value.get('schema_version') != 1
        or value.get('mode') != 'explicit'
        or value.get('evalscope_commit') != 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60'
        or not _bounded_text(value.get('benchmark'), 256)
        or not _bounded_text(value.get('primary_metric_id'), 128)
        or not _bounded_text(value.get('primary_output_key'), 128)
    ):
        raise RuntimePolicyError('task_integration_invalid', 'Task scoring config header is invalid', 500)
    metrics = value.get('metrics')
    if not isinstance(metrics, list) or not 1 <= len(metrics) <= 16:
        raise RuntimePolicyError('task_integration_invalid', 'Task scoring metrics are invalid', 500)
    metric_ids: list[str] = []
    output_keys: set[str] = set()
    primary_output_keys: set[str] = set()
    for metric in metrics:
        if not isinstance(metric, dict) or set(metric) != {
            'id',
            'implementation_digest',
            'parameters',
            'output_keys',
        }:
            raise RuntimePolicyError('task_integration_invalid', 'Task scoring Metric is invalid', 500)
        metric_id = metric.get('id')
        if (
            not isinstance(metric_id, str)
            or not _SAFE_TOKEN.fullmatch(metric_id)
            or not isinstance(metric.get('implementation_digest'), str)
            or not _DIGEST.fullmatch(metric['implementation_digest'])
            or not isinstance(metric.get('parameters'), dict)
            or not isinstance(metric.get('output_keys'), list)
            or not metric['output_keys']
            or len(metric['output_keys']) > 32
        ):
            raise RuntimePolicyError('task_integration_invalid', 'Task scoring Metric is invalid', 500)
        metric_ids.append(metric_id)
        for key, parameter in metric['parameters'].items():
            if (
                not isinstance(key, str)
                or not _SAFE_TOKEN.fullmatch(key)
                or not isinstance(parameter, (str, int, float, bool))
                or (isinstance(parameter, float) and not _finite(parameter))
                or (isinstance(parameter, str) and not _bounded_text(parameter, 512))
            ):
                raise RuntimePolicyError('task_integration_invalid', 'Task scoring parameters are invalid', 500)
        for output_key in metric['output_keys']:
            if not _bounded_text(output_key, 128) or output_key in output_keys:
                raise RuntimePolicyError('task_integration_invalid', 'Task scoring outputs are invalid', 500)
            output_keys.add(output_key)
            if metric_id == value['primary_metric_id']:
                primary_output_keys.add(output_key)
    if metric_ids != sorted(metric_ids) or len(set(metric_ids)) != len(metric_ids):
        raise RuntimePolicyError('task_integration_invalid', 'Task scoring Metrics are not canonical', 500)
    if value['primary_metric_id'] not in metric_ids or value['primary_output_key'] not in primary_output_keys:
        raise RuntimePolicyError('task_integration_invalid', 'Task scoring primary Metric is invalid', 500)


class ProcessRegistry:
    """Single-process registry that never overwrites an active task."""

    def __init__(self) -> None:
        self._values: dict[str, Any] = {}
        self._lock = threading.Lock()

    def register(self, task_id: str, process: Any) -> None:
        validate_task_id(task_id)
        with self._lock:
            if task_id in self._values:
                raise RuntimePolicyError(
                    'process_registry_conflict',
                    'Task already has an active process',
                    409,
                )
            self._values[task_id] = process

    def unregister(self, task_id: str, process: Any | None = None) -> None:
        with self._lock:
            existing = self._values.get(task_id)
            if existing is not None and (process is None or process is existing):
                del self._values[task_id]

    def get(self, task_id: str) -> Any | None:
        with self._lock:
            return self._values.get(task_id)
