"""Exact Dataset materialization and singleton Studio Session storage."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import stat
import threading
from base64 import urlsafe_b64encode
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from blake3 import blake3

from .config import MS_SWIFT_COMMIT, RuntimeConfig
from .errors import ProviderError

_DIGEST = re.compile(r'^[0-9a-f]{64}$')
_LOCATOR = re.compile(r'^sws_[A-Za-z0-9_-]{43}$')
_REQUEST_ID = _DIGEST
_DISPLAY_LABEL = re.compile(r'^[^\x00-\x1f\x7f\u2028\u2029]{1,256}$')
_SESSION_SCHEMA_VERSION = 1
_CURRENT_SCHEMA_VERSION = 1
_CONVERTER = 'ms-swift'
_CONVERTER_VERSION = '1.0.0'
_MEDIA_TYPE = 'application/x-ndjson'


def _stable_json_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(',', ':'),
            allow_nan=False,
        ).encode('utf-8')
        + b'\n'
    )


def _bounded_json_object(path: Path, maximum_bytes: int) -> dict[str, Any]:
    try:
        with path.open('rb') as handle:
            raw = handle.read(maximum_bytes + 1)
    except (OSError, UnicodeError) as exc:
        raise ProviderError(
            'session_state_unavailable',
            'Studio Session state is unavailable',
            503,
        ) from exc
    if len(raw) > maximum_bytes:
        raise ProviderError(
            'session_state_invalid',
            'Studio Session state exceeds its byte bound',
            500,
        )
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProviderError(
            'session_state_invalid',
            'Studio Session state is invalid',
            500,
        ) from exc
    if not isinstance(value, dict):
        raise ProviderError(
            'session_state_invalid',
            'Studio Session state is invalid',
            500,
        )
    return value


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_atomic_json(path: Path, value: Mapping[str, Any], maximum_bytes: int) -> None:
    payload = _stable_json_bytes(value)
    if len(payload) > maximum_bytes:
        raise ProviderError(
            'session_state_too_large',
            'Studio Session state exceeds its byte bound',
            500,
        )
    partial = path.with_name(f'{path.name}.partial')
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
        with os.fdopen(descriptor, 'wb', closefd=True) as handle:
            descriptor = None
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(partial, path)
        _fsync_directory(path.parent)
    except FileExistsError as exc:
        raise ProviderError(
            'session_state_busy',
            'Studio Session state has an incomplete exact write',
            503,
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            partial.unlink()
        except FileNotFoundError:
            pass


def _discard_atomic_partial(path: Path) -> None:
    partial = path.with_name(f'{path.name}.partial')
    try:
        metadata = partial.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise ProviderError(
            'session_state_invalid',
            'Studio Session atomic state path is invalid',
            500,
        )
    partial.unlink()
    _fsync_directory(path.parent)


def _strict_keys(
    value: Any,
    expected: set[str],
    *,
    code: str,
    path: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise ProviderError(code, 'Request must use the exact Provider schema', 422, path)
    return value


def _digest(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _DIGEST.fullmatch(value):
        raise ProviderError(
            'session_request_invalid',
            f'{field} must be 64 lowercase hexadecimal characters',
            422,
            f'/{field}',
        )
    return value


def _positive_integer(value: Any, field: str, maximum: int) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 1
        or value > maximum
    ):
        raise ProviderError(
            'session_request_invalid',
            f'{field} is outside the accepted bound',
            422,
            f'/expected/{field}',
        )
    return value


def _stored_positive_integer(value: Any, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 1 <= value <= maximum
    )


@dataclass(frozen=True)
class ExpectedExport:
    digest: str
    size_bytes: int
    line_count: int


@dataclass(frozen=True)
class CreateSessionRequest:
    request_id: str
    dataset_version: str
    display_label: str
    export_url: str
    export_request: dict[str, Any]
    expected: ExpectedExport

    @classmethod
    def parse(cls, value: Any, config: RuntimeConfig) -> 'CreateSessionRequest':
        payload = _strict_keys(
            value,
            {
                'request_id',
                'dataset_version',
                'display_label',
                'export_url',
                'export_request',
                'expected',
                'converter_version',
            },
            code='session_request_invalid',
            path='/',
        )
        request_id = _digest(payload.get('request_id'), 'request_id')
        dataset_version = _digest(payload.get('dataset_version'), 'dataset_version')
        display_label = payload.get('display_label')
        if not isinstance(display_label, str) or not _DISPLAY_LABEL.fullmatch(display_label):
            raise ProviderError(
                'session_request_invalid',
                'display_label must be a bounded single-line label',
                422,
                '/display_label',
            )
        if payload.get('converter_version') != _CONVERTER_VERSION:
            raise ProviderError(
                'session_request_invalid',
                f'converter_version must be {_CONVERTER_VERSION}',
                422,
                '/converter_version',
            )

        export_request = _strict_keys(
            payload.get('export_request'),
            {'converter', 'options', 'accepted_fidelity_digest'},
            code='session_request_invalid',
            path='/export_request',
        )
        if export_request.get('converter') != _CONVERTER:
            raise ProviderError(
                'session_request_invalid',
                f'Only the {_CONVERTER} converter is supported',
                422,
                '/export_request/converter',
            )
        if export_request.get('options') != {}:
            raise ProviderError(
                'session_request_invalid',
                'ms-swift Session export options must be the normalized empty object',
                422,
                '/export_request/options',
            )
        accepted = export_request.get('accepted_fidelity_digest')
        if accepted is not None and (
            not isinstance(accepted, str) or not _DIGEST.fullmatch(accepted)
        ):
            raise ProviderError(
                'session_request_invalid',
                'accepted_fidelity_digest must be null or an exact digest',
                422,
                '/export_request/accepted_fidelity_digest',
            )

        expected = _strict_keys(
            payload.get('expected'),
            {'digest_algorithm', 'digest', 'size_bytes', 'line_count'},
            code='session_request_invalid',
            path='/expected',
        )
        if expected.get('digest_algorithm') != 'blake3':
            raise ProviderError(
                'session_request_invalid',
                'digest_algorithm must be blake3',
                422,
                '/expected/digest_algorithm',
            )
        expected_export = ExpectedExport(
            digest=_digest(expected.get('digest'), 'digest'),
            size_bytes=_positive_integer(
                expected.get('size_bytes'),
                'size_bytes',
                config.session_export_max_bytes,
            ),
            line_count=_positive_integer(
                expected.get('line_count'),
                'line_count',
                config.session_export_max_lines,
            ),
        )
        export_url = _validated_export_url(
            payload.get('export_url'),
            dataset_version,
            config.databench_origin,
        )
        return cls(
            request_id=request_id,
            dataset_version=dataset_version,
            display_label=display_label,
            export_url=export_url,
            export_request={
                'converter': _CONVERTER,
                'options': {},
                'accepted_fidelity_digest': accepted,
            },
            expected=expected_export,
        )


@dataclass(frozen=True)
class SessionActionRequest:
    request_id: str

    @classmethod
    def parse(cls, value: Any) -> 'SessionActionRequest':
        payload = _strict_keys(
            value,
            {'request_id'},
            code='session_action_invalid',
            path='/',
        )
        return cls(request_id=_digest(payload.get('request_id'), 'request_id'))


def _validated_export_url(value: Any, dataset_version: str, allowed_origin: str) -> str:
    if not isinstance(value, str) or len(value.encode('utf-8')) > 2048:
        raise ProviderError(
            'session_request_invalid',
            'export_url is invalid',
            422,
            '/export_url',
        )
    parsed = urlsplit(value)
    expected_origin = urlsplit(allowed_origin)
    if (
        parsed.scheme != expected_origin.scheme
        or parsed.hostname != expected_origin.hostname
        or parsed.port != expected_origin.port
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path != f'/v2/datasets/{dataset_version}:export'
    ):
        raise ProviderError(
            'session_export_url_rejected',
            'export_url must be the configured Databench origin exact-version export endpoint',
            422,
            '/export_url',
        )
    return value


def validate_locator(value: str) -> str:
    if not _LOCATOR.fullmatch(value):
        raise ProviderError(
            'provider_session_id_invalid',
            'provider_session_id is invalid',
            422,
            '/provider_session_id',
        )
    return value


def provider_session_locator(request_id: str) -> str:
    request_id = _digest(request_id, 'request_id')
    encoded = urlsafe_b64encode(bytes.fromhex(request_id)).decode('ascii').rstrip('=')
    return f'sws_{encoded}'


def _default_native_task_probe(_: Path) -> bool:
    proc = Path('/proc')
    if not proc.is_dir():
        return False
    try:
        entries = os.scandir(proc)
    except OSError:
        return True
    with entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                raw = (proc / entry.name / 'cmdline').read_bytes()
            except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
                continue
            arguments = [
                item.decode('utf-8', errors='replace')
                for item in raw.split(b'\0')
                if item
            ]
            if (
                any(Path(argument).name == 'swift' for argument in arguments)
                and any(
                    command in arguments
                    for command in (
                        'pt',
                        'sft',
                        'rlhf',
                        'deploy',
                        'export',
                        'eval',
                        'sample',
                        'infer',
                    )
                )
            ):
                return True
    return False


class SessionStore:
    """Single-active-session filesystem control plane."""

    def __init__(
        self,
        config: RuntimeConfig,
        *,
        client: httpx.Client | None = None,
        native_task_probe: Callable[[Path], bool] | None = None,
        provider_generation: str | None = None,
    ) -> None:
        self._config = config
        self._root = config.sessions_root
        self._current_path = self._root / 'current.json'
        self._lock = threading.Lock()
        self._native_task_probe = native_task_probe or _default_native_task_probe
        self._generation = provider_generation or f'spg_{secrets.token_urlsafe(18)}'
        headers = {
            'Accept': _MEDIA_TYPE,
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/json',
        }
        if config.databench_service_credential is not None:
            headers['Authorization'] = (
                f'Bearer {config.databench_service_credential}'
            )
        self._export_headers = headers
        self._client = client or httpx.Client(
            follow_redirects=False,
            timeout=httpx.Timeout(
                config.session_export_timeout_seconds,
                connect=config.session_export_connect_timeout_seconds,
            ),
            trust_env=False,
        )
        self._recover_current()

    @property
    def provider_generation(self) -> str:
        return self._generation

    def create(self, request: CreateSessionRequest) -> tuple[dict[str, Any], bool]:
        with self._lock:
            current = self._read_current_manifest(required=False)
            if current is not None:
                if current.get('request_id') == request.request_id:
                    if not self._request_matches_manifest(request, current):
                        raise ProviderError(
                            'session_request_reuse_conflict',
                            'Studio Session request id was reused with different input',
                            409,
                        )
                    return self._create_response(current, replayed=True), True
                raise ProviderError(
                    'active_session_conflict',
                    'Another Swift Studio Session is already active',
                    409,
                )

            locator = provider_session_locator(request.request_id)
            partial_root = self._root / f'{locator}.partial'
            final_root = self._root / locator
            if final_root.exists():
                raise ProviderError(
                    'provider_locator_conflict',
                    'Provider Session locator allocation conflicted',
                    503,
                )
            self._remove_exact_partial(partial_root)
            partial_root.mkdir(mode=0o750)
            final_created = False
            try:
                for name in ('input', 'output', 'logs', 'tmp'):
                    (partial_root / name).mkdir(mode=0o750)
                preparing = self._manifest(request, locator, status='preparing')
                _write_atomic_json(
                    partial_root / 'session.json',
                    preparing,
                    self._config.session_manifest_max_bytes,
                )
                self._write_current(locator, request.request_id, partial=True)
                measured = self._materialize(request, partial_root)
                ready = self._manifest(
                    request,
                    locator,
                    status='ready',
                    measured=measured,
                )
                _write_atomic_json(
                    partial_root / 'session.json',
                    ready,
                    self._config.session_manifest_max_bytes,
                )
                for directory in (
                    partial_root / 'input',
                    partial_root / 'output',
                    partial_root / 'logs',
                    partial_root / 'tmp',
                    partial_root,
                ):
                    _fsync_directory(directory)
                os.rename(partial_root, final_root)
                final_created = True
                _fsync_directory(self._root)
                self._write_current(locator, request.request_id, partial=False)
                return self._create_response(ready, replayed=False), False
            except Exception:
                if final_created:
                    self._recover_current()
                else:
                    self._remove_current_if(locator)
                    self._remove_exact_partial(partial_root)
                raise

    def current(self) -> dict[str, Any]:
        with self._lock:
            manifest = self._read_current_manifest(required=True)
            assert manifest is not None
            return self._create_response(manifest, replayed=False)

    def current_context(self) -> dict[str, Any]:
        with self._lock:
            manifest = self._read_current_manifest(required=True)
            assert manifest is not None
            locator = validate_locator(str(manifest.get('provider_session_id')))
            root = self._session_root(locator)
            return {
                'provider_session_id': locator,
                'status': 'ready',
                'dataset_version': manifest['dataset_version'],
                'display_label': manifest['display_label'],
                'dataset_path': str(root / 'input' / 'ms-swift.jsonl'),
                'output_dir': str(root / 'output'),
                'logging_dir': str(root / 'logs'),
                'provider_generation': self._generation,
            }

    def close(
        self,
        locator: str,
        request: SessionActionRequest,
    ) -> tuple[dict[str, Any], bool]:
        locator = validate_locator(locator)
        with self._lock:
            manifest = self._read_manifest(locator)
            if manifest.get('status') == 'closed':
                existing = manifest.get('close_request_id')
                if existing is not None and existing != request.request_id:
                    raise ProviderError(
                        'session_close_conflict',
                        'Studio Session was closed by another request',
                        409,
                    )
                self._remove_current_if(locator)
                return self._close_response(locator, replayed=True), True
            if manifest.get('status') != 'ready':
                raise ProviderError(
                    'session_state_conflict',
                    'Studio Session is not ready to close',
                    409,
                )
            root = self._session_root(locator)
            _discard_atomic_partial(root / 'session.json')
            if self._native_task_probe(root / 'output'):
                raise ProviderError(
                    'session_has_active_tasks',
                    'Studio Session still has an active native task',
                    409,
                )
            closed = {
                **manifest,
                'status': 'closed',
                'close_request_id': request.request_id,
            }
            _write_atomic_json(
                root / 'session.json',
                closed,
                self._config.session_manifest_max_bytes,
            )
            self._remove_current_if(locator)
            return self._close_response(locator, replayed=False), False

    def cleanup(
        self,
        locator: str,
        request: SessionActionRequest,
    ) -> tuple[dict[str, Any], bool]:
        locator = validate_locator(locator)
        with self._lock:
            manifest = self._read_manifest(locator)
            if manifest.get('status') != 'closed':
                raise ProviderError(
                    'session_cleanup_conflict',
                    'Only a closed Studio Session can be cleaned',
                    409,
                )
            existing = manifest.get('cleanup_request_id')
            if existing is not None and existing != request.request_id:
                raise ProviderError(
                    'session_cleanup_conflict',
                    'Studio Session input cleanup belongs to another request',
                    409,
                )
            if manifest.get('input_cleaned') is True:
                return self._cleanup_response(locator, replayed=True), True
            root = self._session_root(locator)
            _discard_atomic_partial(root / 'session.json')
            if self._native_task_probe(root / 'output'):
                raise ProviderError(
                    'session_has_active_tasks',
                    'Studio Session still has an active native task',
                    409,
                )
            self._validate_cleanup_exact_input(root)
            if existing is None:
                manifest = {
                    **manifest,
                    'cleanup_request_id': request.request_id,
                }
                _write_atomic_json(
                    root / 'session.json',
                    manifest,
                    self._config.session_manifest_max_bytes,
                )
            self._cleanup_exact_input(root)
            cleaned = {
                **manifest,
                'input_cleaned': True,
            }
            _write_atomic_json(
                root / 'session.json',
                cleaned,
                self._config.session_manifest_max_bytes,
            )
            return self._cleanup_response(locator, replayed=False), False

    def _materialize(
        self,
        request: CreateSessionRequest,
        session_root: Path,
    ) -> ExpectedExport:
        input_root = session_root / 'input'
        partial = input_root / 'ms-swift.jsonl.partial'
        final = input_root / 'ms-swift.jsonl'
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
            try:
                stream = self._client.stream(
                    'POST',
                    request.export_url,
                    headers=self._export_headers,
                    json=request.export_request,
                )
                with stream as response:
                    if response.status_code != 200:
                        raise ProviderError(
                            'session_export_rejected',
                            'Databench exact export did not succeed',
                            502,
                        )
                    media_type = response.headers.get('content-type', '').split(';', 1)[
                        0
                    ].strip().lower()
                    if media_type != _MEDIA_TYPE:
                        raise ProviderError(
                            'session_export_protocol_invalid',
                            'Databench exact export returned an unexpected media type',
                            502,
                        )
                    content_encoding = response.headers.get(
                        'content-encoding',
                        'identity',
                    ).strip().lower()
                    if content_encoding != 'identity':
                        raise ProviderError(
                            'session_export_protocol_invalid',
                            'Databench exact export returned encoded content',
                            502,
                        )
                    content_length = response.headers.get('content-length')
                    if content_length is not None:
                        try:
                            declared_length = int(content_length)
                        except ValueError as exc:
                            raise ProviderError(
                                'session_export_protocol_invalid',
                                'Databench exact export returned an invalid Content-Length',
                                502,
                            ) from exc
                        if declared_length != request.expected.size_bytes:
                            raise ProviderError(
                                'session_export_size_mismatch',
                                'Databench exact export Content-Length does not '
                                'match the inspected export',
                                502,
                            )
                    measured_size = 0
                    measured_lines = 0
                    final_byte: int | None = None
                    hasher = blake3()
                    with os.fdopen(descriptor, 'wb', closefd=True) as handle:
                        descriptor = None
                        for chunk in response.iter_bytes():
                            if not chunk:
                                continue
                            measured_size += len(chunk)
                            if (
                                measured_size > request.expected.size_bytes
                                or measured_size
                                > self._config.session_export_max_bytes
                            ):
                                raise ProviderError(
                                    'session_export_size_mismatch',
                                    'Databench exact export exceeded the expected byte count',
                                    502,
                                )
                            measured_lines += chunk.count(b'\n')
                            if (
                                measured_lines > request.expected.line_count
                                or measured_lines
                                > self._config.session_export_max_lines
                            ):
                                raise ProviderError(
                                    'session_export_count_mismatch',
                                    'Databench exact export exceeded the expected output count',
                                    502,
                                )
                            final_byte = chunk[-1]
                            hasher.update(chunk)
                            handle.write(chunk)
                        handle.flush()
                        os.fsync(handle.fileno())
            except ProviderError:
                raise
            except (httpx.HTTPError, OSError) as exc:
                raise ProviderError(
                    'session_export_unavailable',
                    'Databench exact export stream is unavailable',
                    503,
                ) from exc

            measured = ExpectedExport(
                digest=hasher.hexdigest(),
                size_bytes=measured_size,
                line_count=measured_lines,
            )
            if measured.size_bytes != request.expected.size_bytes:
                raise ProviderError(
                    'session_export_size_mismatch',
                    'Databench exact export byte count does not match the inspected export',
                    502,
                )
            if final_byte != ord('\n') or measured.line_count != request.expected.line_count:
                raise ProviderError(
                    'session_export_count_mismatch',
                    'Databench exact export output count does not match the inspected export',
                    502,
                )
            if measured.digest != request.expected.digest:
                raise ProviderError(
                    'session_export_digest_mismatch',
                    'Databench exact export digest does not match the inspected export',
                    502,
                )
            os.chmod(partial, 0o440)
            os.rename(partial, final)
            _fsync_directory(input_root)
            export_manifest = {
                'schema_version': 1,
                'converter': _CONVERTER,
                'converter_version': _CONVERTER_VERSION,
                'dataset_version': request.dataset_version,
                'digest_algorithm': 'blake3',
                'export_digest': measured.digest,
                'export_size_bytes': measured.size_bytes,
                'output_count': measured.line_count,
                'filename': 'ms-swift.jsonl',
            }
            _write_atomic_json(
                input_root / 'export.json',
                export_manifest,
                self._config.session_manifest_max_bytes,
            )
            return measured
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                partial.unlink()
            except FileNotFoundError:
                pass

    def _manifest(
        self,
        request: CreateSessionRequest,
        locator: str,
        *,
        status: str,
        measured: ExpectedExport | None = None,
    ) -> dict[str, Any]:
        export = request.expected if measured is None else measured
        return {
            'schema_version': _SESSION_SCHEMA_VERSION,
            'provider_session_id': locator,
            'request_id': request.request_id,
            'status': status,
            'dataset_version': request.dataset_version,
            'display_label': request.display_label,
            'converter': _CONVERTER,
            'converter_version': _CONVERTER_VERSION,
            'accepted_fidelity_digest': request.export_request[
                'accepted_fidelity_digest'
            ],
            'export_digest': export.digest,
            'export_size_bytes': export.size_bytes,
            'output_count': export.line_count,
            'digest_algorithm': 'blake3',
            'input_filename': 'input/ms-swift.jsonl',
            'output_directory': 'output',
            'logging_directory': 'logs',
            'ms_swift_commit': MS_SWIFT_COMMIT,
            'input_cleaned': False,
        }

    def _write_current(self, locator: str, request_id: str, *, partial: bool) -> None:
        _write_atomic_json(
            self._current_path,
            {
                'schema_version': _CURRENT_SCHEMA_VERSION,
                'provider_session_id': locator,
                'request_id': request_id,
                'partial': partial,
            },
            self._config.session_manifest_max_bytes,
        )

    def _read_current_manifest(self, *, required: bool) -> dict[str, Any] | None:
        if not self._current_path.exists():
            if required:
                raise ProviderError(
                    'active_session_not_found',
                    'There is no active Swift Studio Session',
                    404,
                )
            return None
        current = self._read_current_pointer()
        locator = current['provider_session_id']
        if current.get('partial') is not False:
            raise ProviderError(
                'session_preparing',
                'Swift Studio Session materialization is incomplete',
                503,
            )
        manifest = self._read_manifest(locator)
        if manifest.get('request_id') != current.get('request_id'):
            raise ProviderError(
                'session_state_invalid',
                'Current Studio Session binding is inconsistent',
                500,
            )
        if manifest.get('status') != 'ready':
            self._remove_current_if(locator)
            if required:
                raise ProviderError(
                    'active_session_not_found',
                    'There is no active Swift Studio Session',
                    404,
                )
            return None
        return manifest

    def _read_manifest(self, locator: str) -> dict[str, Any]:
        root = self._session_root(locator)
        manifest = _bounded_json_object(
            root / 'session.json',
            self._config.session_manifest_max_bytes,
        )
        required = {
            'schema_version',
            'provider_session_id',
            'request_id',
            'status',
            'dataset_version',
            'display_label',
            'converter',
            'converter_version',
            'accepted_fidelity_digest',
            'export_digest',
            'export_size_bytes',
            'output_count',
            'digest_algorithm',
            'input_filename',
            'output_directory',
            'logging_directory',
            'ms_swift_commit',
            'input_cleaned',
        }
        optional = {'close_request_id', 'cleanup_request_id'}
        status = manifest.get('status')
        close_request_id = manifest.get('close_request_id')
        cleanup_request_id = manifest.get('cleanup_request_id')
        accepted_fidelity_digest = manifest.get('accepted_fidelity_digest')
        if (
            not required.issubset(manifest)
            or set(manifest) - required - optional
            or manifest.get('schema_version') != _SESSION_SCHEMA_VERSION
            or manifest.get('provider_session_id') != locator
            or manifest.get('converter') != _CONVERTER
            or manifest.get('converter_version') != _CONVERTER_VERSION
            or (
                accepted_fidelity_digest is not None
                and (
                    not isinstance(accepted_fidelity_digest, str)
                    or not _DIGEST.fullmatch(accepted_fidelity_digest)
                )
            )
            or manifest.get('digest_algorithm') != 'blake3'
            or manifest.get('input_filename') != 'input/ms-swift.jsonl'
            or manifest.get('output_directory') != 'output'
            or manifest.get('logging_directory') != 'logs'
            or manifest.get('ms_swift_commit') != MS_SWIFT_COMMIT
            or status not in {'preparing', 'ready', 'closed'}
            or not isinstance(manifest.get('display_label'), str)
            or not _DISPLAY_LABEL.fullmatch(manifest['display_label'])
            or not _stored_positive_integer(
                manifest.get('export_size_bytes'),
                self._config.session_export_max_bytes,
            )
            or not _stored_positive_integer(
                manifest.get('output_count'),
                self._config.session_export_max_lines,
            )
            or not isinstance(manifest.get('input_cleaned'), bool)
        ):
            raise ProviderError(
                'session_state_invalid',
                'Studio Session manifest is invalid',
                500,
            )
        for field in ('request_id', 'dataset_version', 'export_digest'):
            value = manifest.get(field)
            if not isinstance(value, str) or not _DIGEST.fullmatch(value):
                raise ProviderError(
                    'session_state_invalid',
                    'Studio Session manifest is invalid',
                    500,
                )
        if provider_session_locator(manifest['request_id']) != locator:
            raise ProviderError(
                'session_state_invalid',
                'Studio Session locator binding is invalid',
                500,
            )
        for field in optional:
            value = manifest.get(field)
            if field in manifest and (
                not isinstance(value, str) or not _REQUEST_ID.fullmatch(value)
            ):
                raise ProviderError(
                    'session_state_invalid',
                    'Studio Session action binding is invalid',
                    500,
                )
        if (
            status in {'preparing', 'ready'}
            and (
                close_request_id is not None
                or cleanup_request_id is not None
                or manifest['input_cleaned'] is not False
            )
        ) or (
            status == 'closed'
            and (
                close_request_id is None
                or (
                    manifest['input_cleaned'] is True
                    and cleanup_request_id is None
                )
            )
        ):
            raise ProviderError(
                'session_state_invalid',
                'Studio Session lifecycle state is invalid',
                500,
            )
        return manifest

    def _request_matches_manifest(
        self,
        request: CreateSessionRequest,
        manifest: Mapping[str, Any],
    ) -> bool:
        return (
            manifest.get('request_id') == request.request_id
            and manifest.get('dataset_version') == request.dataset_version
            and manifest.get('converter') == _CONVERTER
            and manifest.get('converter_version') == _CONVERTER_VERSION
            and manifest.get('accepted_fidelity_digest')
            == request.export_request['accepted_fidelity_digest']
            and manifest.get('export_digest') == request.expected.digest
            and manifest.get('export_size_bytes') == request.expected.size_bytes
            and manifest.get('output_count') == request.expected.line_count
        )

    def _read_current_pointer(self) -> dict[str, Any]:
        current = _bounded_json_object(
            self._current_path,
            self._config.session_manifest_max_bytes,
        )
        request_id = current.get('request_id')
        locator = current.get('provider_session_id')
        if (
            set(current)
            != {
                'schema_version',
                'provider_session_id',
                'request_id',
                'partial',
            }
            or current.get('schema_version') != _CURRENT_SCHEMA_VERSION
            or not isinstance(request_id, str)
            or not _REQUEST_ID.fullmatch(request_id)
            or not isinstance(locator, str)
            or not _LOCATOR.fullmatch(locator)
            or locator != provider_session_locator(request_id)
            or not isinstance(current.get('partial'), bool)
        ):
            raise ProviderError(
                'session_state_invalid',
                'Current Studio Session pointer is invalid',
                500,
            )
        return current

    def _session_root(self, locator: str) -> Path:
        locator = validate_locator(locator)
        path = self._root / locator
        try:
            metadata = path.lstat()
        except FileNotFoundError as exc:
            raise ProviderError(
                'provider_session_not_found',
                'Swift Studio Provider Session was not found',
                404,
            ) from exc
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise ProviderError(
                'session_path_invalid',
                'Swift Studio Provider Session path is invalid',
                500,
            )
        resolved = path.resolve(strict=True)
        root = self._root.resolve(strict=True)
        if resolved.parent != root:
            raise ProviderError(
                'session_path_invalid',
                'Swift Studio Provider Session escaped its exact root',
                500,
            )
        return resolved

    def _recover_current(self) -> None:
        self._root.mkdir(mode=0o750, parents=True, exist_ok=True)
        _discard_atomic_partial(self._current_path)
        if not self._current_path.exists():
            return
        current = self._read_current_pointer()
        locator = current['provider_session_id']
        if current.get('partial') is True:
            final_root = self._root / locator
            partial_root = self._root / f'{locator}.partial'
            if final_root.exists():
                manifest = self._read_manifest(locator)
                if (
                    manifest.get('status') == 'ready'
                    and manifest.get('request_id') == current['request_id']
                ):
                    _discard_atomic_partial(final_root / 'session.json')
                    self._write_current(locator, current['request_id'], partial=False)
                    self._remove_exact_partial(partial_root)
                    return
                raise ProviderError(
                    'session_state_invalid',
                    'Final Studio Session does not match its preparing pointer',
                    500,
                )
            self._remove_exact_partial(partial_root)
            self._remove_current_if(locator)
            return
        manifest = self._read_manifest(locator)
        _discard_atomic_partial(self._session_root(locator) / 'session.json')
        if manifest.get('status') == 'closed':
            self._remove_current_if(locator)
        elif manifest.get('status') != 'ready':
            raise ProviderError(
                'session_state_invalid',
                'Current Studio Session has an invalid lifecycle state',
                500,
            )

    def _remove_current_if(self, locator: str) -> None:
        if not self._current_path.exists():
            return
        try:
            current = self._read_current_pointer()
        except ProviderError:
            raise
        if current.get('provider_session_id') != locator:
            return
        self._current_path.unlink()
        _fsync_directory(self._root)

    def _remove_exact_partial(self, partial_root: Path) -> None:
        try:
            metadata = partial_root.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise ProviderError(
                'session_path_invalid',
                'Partial Studio Session path is invalid',
                500,
            )
        shutil.rmtree(partial_root)
        _fsync_directory(self._root)

    def _validate_cleanup_exact_input(self, root: Path) -> None:
        input_root = root / 'input'
        tmp_root = root / 'tmp'
        for directory, allowed in (
            (input_root, {'ms-swift.jsonl', 'export.json'}),
            (tmp_root, set()),
        ):
            try:
                metadata = directory.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise ProviderError(
                    'session_cleanup_rejected',
                    'Studio Session cleanup path is invalid',
                    409,
                )
            with os.scandir(directory) as entries:
                names = {entry.name for entry in entries}
            if names - allowed:
                raise ProviderError(
                    'session_cleanup_rejected',
                    'Studio Session cleanup found an unexpected exact path',
                    409,
                )
        for path in (input_root / 'ms-swift.jsonl', input_root / 'export.json'):
            try:
                metadata = path.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise ProviderError(
                    'session_cleanup_rejected',
                    'Studio Session input is not an exact regular file',
                    409,
                )

    def _cleanup_exact_input(self, root: Path) -> None:
        self._validate_cleanup_exact_input(root)
        input_root = root / 'input'
        tmp_root = root / 'tmp'
        for path in (input_root / 'ms-swift.jsonl', input_root / 'export.json'):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        if input_root.exists():
            _fsync_directory(input_root)
        try:
            input_root.rmdir()
        except FileNotFoundError:
            pass
        try:
            tmp_root.rmdir()
        except FileNotFoundError:
            pass
        _fsync_directory(root)

    def _create_response(
        self,
        manifest: Mapping[str, Any],
        *,
        replayed: bool,
    ) -> dict[str, Any]:
        return {
            'provider_session_id': manifest['provider_session_id'],
            'status': 'ready',
            'dataset_version': manifest['dataset_version'],
            'converter': _CONVERTER,
            'converter_version': _CONVERTER_VERSION,
            'export_digest': manifest['export_digest'],
            'export_size_bytes': manifest['export_size_bytes'],
            'output_count': manifest['output_count'],
            'provider_generation': self._generation,
            'replayed': replayed,
        }

    def _close_response(self, locator: str, *, replayed: bool) -> dict[str, Any]:
        return {
            'provider_session_id': locator,
            'status': 'closed',
            'provider_generation': self._generation,
            'replayed': replayed,
        }

    def _cleanup_response(self, locator: str, *, replayed: bool) -> dict[str, Any]:
        return {
            'provider_session_id': locator,
            'status': 'cleaned',
            'provider_generation': self._generation,
            'replayed': replayed,
        }
