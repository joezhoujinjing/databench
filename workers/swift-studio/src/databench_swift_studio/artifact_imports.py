"""Asynchronous, replayable upload of exact Swift LoRA snapshots."""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
from base64 import urlsafe_b64encode
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from blake3 import blake3

from .artifacts import ArtifactCore
from .errors import ProviderError
from .sessions import validate_locator

_DIGEST = re.compile(r'^[0-9a-f]{64}$')
_HANDLE = re.compile(r'^swo_[A-Za-z0-9_-]{43}$')
_IMPORT_ID = re.compile(r'^swai_[A-Za-z0-9_-]{43}$')
_UUID = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)
_STAGING_KEY = re.compile(
    r'^staging/swift-artifact/v1/([0-9a-f-]{36})/archive\.tar\.zst$'
)
_VISIBLE = re.compile(r'^[^\x00-\x1f\x7f\u2028\u2029]+$')
_MEDIA_TYPE = 'application/zstd'


def _strict_object(value: Any, keys: set[str], path: str = '/') -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ProviderError(
            'artifact_import_request_invalid',
            'Artifact import request must use the exact Provider schema',
            422,
            path,
        )
    return value


def _digest(value: Any, path: str) -> str:
    if not isinstance(value, str) or _DIGEST.fullmatch(value) is None:
        raise ProviderError(
            'artifact_import_request_invalid',
            f'{path} must be a lowercase BLAKE3 digest',
            422,
            f'/{path}',
        )
    return value


def _bounded_text(value: Any, maximum_bytes: int, path: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode('utf-8')) > maximum_bytes
        or _VISIBLE.fullmatch(value) is None
    ):
        raise ProviderError(
            'artifact_import_request_invalid',
            f'{path} is invalid',
            422,
            f'/{path}',
        )
    return value


def provider_artifact_import_id(request_id: str) -> str:
    request_id = _digest(request_id, 'request_id')
    return f"swai_{urlsafe_b64encode(bytes.fromhex(request_id)).decode('ascii').rstrip('=')}"


def _staging_key(value: Any) -> str:
    if not isinstance(value, str):
        raise ProviderError(
            'artifact_import_request_invalid',
            'staging_object_key is invalid',
            422,
            '/staging_object_key',
        )
    match = _STAGING_KEY.fullmatch(value)
    if match is None or _UUID.fullmatch(match.group(1)) is None:
        raise ProviderError(
            'artifact_import_request_invalid',
            'staging_object_key is invalid',
            422,
            '/staging_object_key',
        )
    return value


def _upload_url(value: Any) -> str:
    if not isinstance(value, str) or len(value.encode('utf-8')) > 8192:
        raise ProviderError(
            'artifact_import_request_invalid',
            'staging_upload_url is invalid',
            422,
            '/staging_upload_url',
        )
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {'http', 'https'}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ProviderError(
            'artifact_import_request_invalid',
            'staging_upload_url is invalid',
            422,
            '/staging_upload_url',
        )
    return value


def _expires_at(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 64:
        raise ProviderError(
            'artifact_import_request_invalid',
            'staging_upload_expires_at is invalid',
            422,
            '/staging_upload_expires_at',
        )
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ProviderError(
            'artifact_import_request_invalid',
            'staging_upload_expires_at is invalid',
            422,
            '/staging_upload_expires_at',
        ) from exc
    if parsed.tzinfo is None or parsed <= datetime.now(UTC):
        raise ProviderError(
            'artifact_upload_target_expired',
            'Artifact staging upload target is expired',
            409,
            '/staging_upload_expires_at',
        )
    return value


@dataclass(frozen=True)
class ArtifactImportRequest:
    request_id: str
    provider_session_id: str
    output_handle: str
    artifact_kind: str
    display_name: str
    base_model_reference: str
    base_model_revision: str | None
    staging_object_key: str
    staging_max_size_bytes: int
    staging_upload_url: str
    staging_upload_expires_at: str

    @classmethod
    def parse(cls, value: Any, provider_session_id: str) -> 'ArtifactImportRequest':
        payload = _strict_object(
            value,
            {
                'request_id',
                'provider_session_id',
                'output_handle',
                'artifact_kind',
                'display_name',
                'base_model',
                'staging_object_key',
                'staging_max_size_bytes',
                'staging_upload_url',
                'staging_upload_expires_at',
            },
        )
        locator = validate_locator(provider_session_id)
        if payload.get('provider_session_id') != locator:
            raise ProviderError(
                'artifact_import_request_invalid',
                'Provider Session path and request body do not match',
                422,
                '/provider_session_id',
            )
        handle = payload.get('output_handle')
        if not isinstance(handle, str) or _HANDLE.fullmatch(handle) is None:
            raise ProviderError(
                'artifact_import_request_invalid',
                'output_handle is invalid',
                422,
                '/output_handle',
            )
        if payload.get('artifact_kind') != 'lora_adapter':
            raise ProviderError(
                'artifact_kind_unsupported',
                'Only lora_adapter can be imported',
                422,
                '/artifact_kind',
            )
        base = _strict_object(
            payload.get('base_model'),
            {'reference', 'revision'},
            '/base_model',
        )
        revision = base.get('revision')
        if revision is not None:
            revision = _bounded_text(revision, 256, 'base_model/revision')
        staging_max_size_bytes = payload.get('staging_max_size_bytes')
        if (
            not isinstance(staging_max_size_bytes, int)
            or isinstance(staging_max_size_bytes, bool)
            or staging_max_size_bytes < 1
            or staging_max_size_bytes > 64 * 1024 * 1024 * 1024
        ):
            raise ProviderError(
                'artifact_import_request_invalid',
                'staging_max_size_bytes is invalid',
                422,
                '/staging_max_size_bytes',
            )
        return cls(
            request_id=_digest(payload.get('request_id'), 'request_id'),
            provider_session_id=locator,
            output_handle=handle,
            artifact_kind='lora_adapter',
            display_name=_bounded_text(payload.get('display_name'), 256, 'display_name'),
            base_model_reference=_bounded_text(
                base.get('reference'), 512, 'base_model/reference'
            ),
            base_model_revision=revision,
            staging_object_key=_staging_key(payload.get('staging_object_key')),
            staging_max_size_bytes=staging_max_size_bytes,
            staging_upload_url=_upload_url(payload.get('staging_upload_url')),
            staging_upload_expires_at=_expires_at(
                payload.get('staging_upload_expires_at')
            ),
        )

    def identity(self) -> dict[str, Any]:
        return {
            'request_id': self.request_id,
            'provider_session_id': self.provider_session_id,
            'output_handle_digest': blake3(self.output_handle.encode('utf-8')).hexdigest(),
            'artifact_kind': self.artifact_kind,
            'display_name': self.display_name,
            'base_model': {
                'reference': self.base_model_reference,
                'revision': self.base_model_revision,
            },
            'staging_object_key': self.staging_object_key,
            'staging_max_size_bytes': self.staging_max_size_bytes,
        }


Uploader = Callable[[str, Path, int], None]


class ArtifactImportManager:
    """One-process async importer with exact terminal replay on the Session filesystem."""

    def __init__(
        self,
        core: ArtifactCore,
        *,
        state_root: Path,
        uploader: Uploader | None = None,
    ) -> None:
        self._core = core
        self._state_root = state_root
        self._state_root.mkdir(mode=0o750, parents=True, exist_ok=True)
        if self._state_root.is_symlink() or not self._state_root.is_dir():
            raise ValueError('Artifact import state root must be an exact directory')
        self._uploader = uploader or self._upload
        self._lock = threading.Lock()
        self._states: dict[str, dict[str, Any]] = {}

    def start(self, request: ArtifactImportRequest) -> tuple[dict[str, Any], bool]:
        provider_import_id = provider_artifact_import_id(request.request_id)
        import_root = self._import_root(provider_import_id)
        with self._lock:
            existing = self._states.get(provider_import_id)
            if existing is not None:
                self._assert_replay(existing, request)
                return {**existing['response'], 'replayed': True}, True
            persisted = self._read_terminal(import_root)
            if persisted is not None:
                self._assert_replay(persisted, request)
                self._states[provider_import_id] = persisted
                return {**persisted['response'], 'replayed': True}, True
            started = self._read_started(import_root)
            if started is not None:
                self._assert_replay(started, request)
                recovered = self._interrupt_started(import_root, started)
                self._states[provider_import_id] = recovered
                return {**recovered['response'], 'replayed': True}, True
            if import_root.exists():
                raise ProviderError(
                    'artifact_import_state_conflict',
                    'Artifact import state is incomplete or conflicted',
                    503,
                )
            generation, snapshot_digest = self._core.snapshot_identity(
                request.provider_session_id,
                request.output_handle,
            )
            state = {
                'identity': request.identity(),
                'response': self._response(
                    request,
                    provider_import_id,
                    generation,
                    snapshot_digest,
                    status='staging',
                ),
            }
            self._write_started(import_root, state)
            self._states[provider_import_id] = state
            thread = threading.Thread(
                target=self._run,
                args=(request, provider_import_id, generation, snapshot_digest, import_root),
                daemon=True,
                name=f'swift-artifact-{provider_import_id[-12:]}',
            )
            thread.start()
            return dict(state['response']), False

    def get(self, provider_import_id: str) -> dict[str, Any]:
        if _IMPORT_ID.fullmatch(provider_import_id) is None:
            raise ProviderError(
                'provider_import_id_invalid',
                'provider_import_id is invalid',
                422,
            )
        with self._lock:
            state = self._states.get(provider_import_id)
            if state is not None:
                return dict(state['response'])
        import_root = self._import_root(provider_import_id)
        persisted = self._read_terminal(import_root)
        if persisted is None:
            started = self._read_started(import_root)
            if started is None:
                raise ProviderError(
                    'artifact_import_not_found',
                    'Artifact import was not found',
                    404,
                )
            persisted = self._interrupt_started(import_root, started)
        with self._lock:
            self._states[provider_import_id] = persisted
        return dict(persisted['response'])

    def has_active_session_import(self, provider_session_id: str) -> bool:
        locator = validate_locator(provider_session_id)
        with self._lock:
            return any(
                state.get('identity', {}).get('provider_session_id') == locator
                and state.get('response', {}).get('status') == 'staging'
                for state in self._states.values()
            )

    def _run(
        self,
        request: ArtifactImportRequest,
        provider_import_id: str,
        generation: str,
        snapshot_digest: str,
        import_root: Path,
    ) -> None:
        archive = import_root / 'archive.tar.zst'
        try:
            built = self._core.build_lora_adapter(
                request.output_handle,
                archive,
                max_archive_bytes=request.staging_max_size_bytes,
            )
            if built.archive_size_bytes > request.staging_max_size_bytes:
                raise ProviderError(
                    'artifact_archive_too_large',
                    'Artifact archive exceeds the staging byte limit',
                    413,
                )
            metadata = dict(built.provider_metadata)
            if metadata.get('output_snapshot_digest') != snapshot_digest:
                raise ProviderError(
                    'output_snapshot_changed',
                    'Artifact snapshot identity changed during archive construction',
                    409,
                )
            _expires_at(request.staging_upload_expires_at)
            self._uploader(request.staging_upload_url, archive, built.archive_size_bytes)
            response = self._response(
                request,
                provider_import_id,
                generation,
                snapshot_digest,
                status='staged',
                archive_digest=built.archive_digest,
                archive_size_bytes=built.archive_size_bytes,
                provider_metadata=metadata,
            )
        except Exception as error:
            if isinstance(error, ProviderError):
                code = error.code
                message = error.message
            else:
                code = 'artifact_staging_failed'
                message = 'Artifact archive could not be staged'
            response = self._response(
                request,
                provider_import_id,
                generation,
                snapshot_digest,
                status='failed',
                failure={
                    'phase': 'provider',
                    'code': code,
                    'message': message,
                },
            )
        state = {'identity': request.identity(), 'response': response}
        try:
            self._write_terminal(import_root, state)
        finally:
            try:
                archive.unlink()
            except FileNotFoundError:
                pass
            with self._lock:
                self._states[provider_import_id] = state

    def _response(
        self,
        request: ArtifactImportRequest,
        provider_import_id: str,
        generation: str,
        snapshot_digest: str,
        *,
        status: str,
        archive_digest: str | None = None,
        archive_size_bytes: int | None = None,
        provider_metadata: Mapping[str, Any] | None = None,
        failure: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            'provider_import_id': provider_import_id,
            'request_id': request.request_id,
            'provider_session_id': request.provider_session_id,
            'provider_generation': generation,
            'status': status,
            'output_snapshot_digest': snapshot_digest,
            'staging_object_key': request.staging_object_key,
            'archive_digest': archive_digest,
            'archive_size_bytes': archive_size_bytes,
            'provider_metadata': provider_metadata,
            'failure': failure,
            'replayed': False,
        }

    def _import_root(self, provider_import_id: str) -> Path:
        return self._state_root / provider_import_id

    @staticmethod
    def _assert_replay(state: Mapping[str, Any], request: ArtifactImportRequest) -> None:
        if state.get('identity') != request.identity():
            raise ProviderError(
                'artifact_import_request_reuse_conflict',
                'Artifact import request id was reused with different input',
                409,
            )

    @staticmethod
    def _write_started(import_root: Path, state: Mapping[str, Any]) -> None:
        partial_root = import_root.parent / (
            f'.{import_root.name}.{secrets.token_urlsafe(8)}.partial'
        )
        partial_root.mkdir(mode=0o750)
        try:
            ArtifactImportManager._write_state_file(
                partial_root,
                'started.json',
                state,
            )
            os.rename(partial_root, import_root)
            directory = os.open(
                import_root.parent,
                os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0),
            )
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                (partial_root / 'started.json').unlink()
            except FileNotFoundError:
                pass
            try:
                partial_root.rmdir()
            except FileNotFoundError:
                pass

    @staticmethod
    def _write_terminal(import_root: Path, state: Mapping[str, Any]) -> None:
        ArtifactImportManager._write_state_file(import_root, 'terminal.json', state)

    @staticmethod
    def _write_state_file(
        import_root: Path,
        filename: str,
        state: Mapping[str, Any],
    ) -> None:
        payload = json.dumps(
            state,
            ensure_ascii=False,
            sort_keys=True,
            separators=(',', ':'),
            allow_nan=False,
        ).encode('utf-8')
        if len(payload) > 512 * 1024:
            raise ProviderError(
                'artifact_import_state_too_large',
                'Artifact import terminal state exceeds its byte bound',
                500,
            )
        partial = import_root / f'.terminal.{secrets.token_urlsafe(8)}.partial'
        descriptor = os.open(
            partial,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0),
            0o600,
        )
        try:
            with os.fdopen(descriptor, 'wb', closefd=True) as handle:
                descriptor = -1
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(partial, import_root / filename)
            directory = os.open(import_root, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                partial.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _read_terminal(import_root: Path) -> dict[str, Any] | None:
        return ArtifactImportManager._read_state_file(
            import_root / 'terminal.json',
        )

    @staticmethod
    def _read_started(import_root: Path) -> dict[str, Any] | None:
        return ArtifactImportManager._read_state_file(
            import_root / 'started.json',
        )

    @staticmethod
    def _read_state_file(path: Path) -> dict[str, Any] | None:
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise ProviderError(
                'artifact_import_state_unavailable',
                'Artifact import terminal state is unavailable',
                503,
            ) from exc
        if len(raw) > 512 * 1024:
            raise ProviderError(
                'artifact_import_state_invalid',
                'Artifact import terminal state is invalid',
                500,
            )
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderError(
                'artifact_import_state_invalid',
                'Artifact import terminal state is invalid',
                500,
            ) from exc
        if not isinstance(value, dict) or set(value) != {'identity', 'response'}:
            raise ProviderError(
                'artifact_import_state_invalid',
                'Artifact import terminal state is invalid',
                500,
            )
        return value

    @staticmethod
    def _interrupt_started(
        import_root: Path,
        started: Mapping[str, Any],
    ) -> dict[str, Any]:
        response = started.get('response')
        if not isinstance(response, dict) or response.get('status') != 'staging':
            raise ProviderError(
                'artifact_import_state_invalid',
                'Artifact import started state is invalid',
                500,
            )
        failed = {
            'identity': started.get('identity'),
            'response': {
                **response,
                'status': 'failed',
                'archive_digest': None,
                'archive_size_bytes': None,
                'provider_metadata': None,
                'failure': {
                    'phase': 'provider',
                    'code': 'artifact_import_interrupted',
                    'message': 'Artifact import was interrupted before staging completed',
                },
                'replayed': False,
            },
        }
        ArtifactImportManager._write_terminal(import_root, failed)
        return failed

    @staticmethod
    def _upload(url: str, path: Path, size: int) -> None:
        try:
            with path.open('rb') as source:
                response = httpx.put(
                    url,
                    content=source,
                    headers={
                        'Content-Type': _MEDIA_TYPE,
                        'Content-Length': str(size),
                    },
                    follow_redirects=False,
                    timeout=httpx.Timeout(3600, connect=10),
                    trust_env=False,
                )
        except (OSError, httpx.HTTPError) as exc:
            raise ProviderError(
                'artifact_staging_upload_unavailable',
                'Artifact staging upload is unavailable',
                503,
            ) from exc
        if response.status_code < 200 or response.status_code >= 300:
            raise ProviderError(
                'artifact_staging_upload_rejected',
                'Artifact staging upload was rejected',
                502,
            )
