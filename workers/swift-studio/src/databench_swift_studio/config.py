"""Runtime configuration for the Swift Studio Provider."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from re import fullmatch
from typing import Mapping
from urllib.parse import urlsplit

MS_SWIFT_VERSION = '4.4.2'
MS_SWIFT_COMMIT = 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d'
GRADIO_VERSION = '5.50.0'
SWIFT_STUDIO_ROOT_PATH = '/swift-studio'
CAPABILITY_MANIFEST_SHA256 = (
    '441a53584131400a9ba462bd262e931ca584f411d721b009ee122f165da3828f'
)
TOP_LEVEL_SURFACES = (
    'llm_train',
    'llm_rlhf',
    'llm_grpo',
    'llm_infer',
    'llm_export',
    'llm_eval',
    'llm_sample',
)
DEFAULT_CAPABILITY_MANIFEST_PATH = Path(
    '/opt/databench-swift-studio/runtime-capabilities.json'
)
DEFAULT_DATABENCH_ORIGIN = 'http://api:8000'


def _port(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f'{name} must be an integer') from exc
    if value < 1 or value > 65_535:
        raise ValueError(f'{name} must be between 1 and 65535')
    return value


def _absolute_root(env: Mapping[str, str]) -> Path:
    raw = env.get('DATABENCH_SWIFT_WORKSPACE_ROOT', '/var/lib/databench-swift-studio').strip()
    root = Path(raw)
    if not root.is_absolute():
        raise ValueError('DATABENCH_SWIFT_WORKSPACE_ROOT must be absolute')
    resolved = root.resolve(strict=False)
    if resolved == Path('/'):
        raise ValueError('DATABENCH_SWIFT_WORKSPACE_ROOT cannot be the filesystem root')
    return resolved


def _absolute_manifest_path(env: Mapping[str, str]) -> Path:
    raw = env.get(
        'DATABENCH_SWIFT_CAPABILITY_MANIFEST',
        str(DEFAULT_CAPABILITY_MANIFEST_PATH),
    ).strip()
    path = Path(raw)
    if not path.is_absolute():
        raise ValueError('DATABENCH_SWIFT_CAPABILITY_MANIFEST must be absolute')
    return path.resolve(strict=False)


def _bounded_integer(
    env: Mapping[str, str],
    name: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    raw = env.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f'{name} must be an integer') from exc
    if value < minimum or value > maximum:
        raise ValueError(f'{name} must be between {minimum} and {maximum}')
    return value


def _databench_origin(env: Mapping[str, str]) -> str:
    raw = env.get('DATABENCH_API_BASE_URL', DEFAULT_DATABENCH_ORIGIN).strip()
    parsed = urlsplit(raw)
    if (
        parsed.scheme not in {'http', 'https'}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {'', '/'}
    ):
        raise ValueError(
            'DATABENCH_API_BASE_URL must be an HTTP(S) origin without path or credentials'
        )
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError('DATABENCH_API_BASE_URL has an invalid port') from exc
    authority = parsed.hostname
    if ':' in authority and not authority.startswith('['):
        authority = f'[{authority}]'
    if port is not None:
        authority = f'{authority}:{port}'
    return f'{parsed.scheme}://{authority}'


def _service_credential(env: Mapping[str, str]) -> str | None:
    raw = env.get('DATABENCH_SWIFT_PROVIDER_CREDENTIAL')
    if raw is None or raw == '':
        return None
    if len(raw.encode('utf-8')) > 2048 or fullmatch(r'[\x21-\x7e]+', raw) is None:
        raise ValueError(
            'DATABENCH_SWIFT_PROVIDER_CREDENTIAL must be bounded visible ASCII'
        )
    return raw


@dataclass(frozen=True)
class RuntimeConfig:
    capability_manifest_path: Path
    databench_origin: str
    databench_service_credential: str | None
    gradio_host: str
    gradio_port: int
    provider_host: str
    provider_port: int
    root_path: str
    session_export_connect_timeout_seconds: int
    session_export_max_bytes: int
    session_export_max_lines: int
    session_export_timeout_seconds: int
    session_manifest_max_bytes: int
    session_request_max_bytes: int
    workspace_root: Path

    @classmethod
    def from_env(cls, source: Mapping[str, str] | None = None) -> 'RuntimeConfig':
        env = os.environ if source is None else source
        root_path = env.get('DATABENCH_SWIFT_ROOT_PATH', SWIFT_STUDIO_ROOT_PATH).strip()
        if root_path != SWIFT_STUDIO_ROOT_PATH:
            raise ValueError(f'DATABENCH_SWIFT_ROOT_PATH must be {SWIFT_STUDIO_ROOT_PATH}')
        if env.get('WEBUI_SHARE', 'false').strip().lower() != 'false':
            raise ValueError('WEBUI_SHARE must remain false')
        gradio_host = env.get('WEBUI_SERVER', '0.0.0.0').strip()
        provider_host = env.get('DATABENCH_SWIFT_PROVIDER_HOST', '0.0.0.0').strip()
        if gradio_host != '0.0.0.0' or provider_host != '0.0.0.0':
            raise ValueError(
                'Swift Studio services must bind to 0.0.0.0 inside the '
                'private container network'
            )
        gradio_port = _port(env, 'WEBUI_PORT', 7860)
        provider_port = _port(env, 'DATABENCH_SWIFT_PROVIDER_PORT', 7861)
        if gradio_port == provider_port:
            raise ValueError('Gradio and Provider ports must be distinct')
        return cls(
            capability_manifest_path=_absolute_manifest_path(env),
            databench_origin=_databench_origin(env),
            databench_service_credential=_service_credential(env),
            gradio_host=gradio_host,
            gradio_port=gradio_port,
            provider_host=provider_host,
            provider_port=provider_port,
            root_path=root_path,
            session_export_connect_timeout_seconds=_bounded_integer(
                env,
                'DATABENCH_SWIFT_EXPORT_CONNECT_TIMEOUT_SECONDS',
                10,
                1,
                60,
            ),
            session_export_max_bytes=_bounded_integer(
                env,
                'DATABENCH_SWIFT_EXPORT_MAX_BYTES',
                8 * 1024 * 1024 * 1024,
                1,
                64 * 1024 * 1024 * 1024,
            ),
            session_export_max_lines=_bounded_integer(
                env,
                'DATABENCH_SWIFT_EXPORT_MAX_LINES',
                10_000_000,
                1,
                100_000_000,
            ),
            session_export_timeout_seconds=_bounded_integer(
                env,
                'DATABENCH_SWIFT_EXPORT_TIMEOUT_SECONDS',
                3600,
                10,
                14_400,
            ),
            session_manifest_max_bytes=_bounded_integer(
                env,
                'DATABENCH_SWIFT_SESSION_MANIFEST_MAX_BYTES',
                64 * 1024,
                1024,
                1024 * 1024,
            ),
            session_request_max_bytes=_bounded_integer(
                env,
                'DATABENCH_SWIFT_SESSION_REQUEST_MAX_BYTES',
                64 * 1024,
                1024,
                1024 * 1024,
            ),
            workspace_root=_absolute_root(env),
        )

    @property
    def local_gradio_config_url(self) -> str:
        return f'http://127.0.0.1:{self.gradio_port}/config'

    def prepare(self) -> None:
        for directory in (
            self.workspace_root,
            self.workspace_root / 'inputs',
            self.workspace_root / 'outputs',
            self.workspace_root / 'logs',
            self.workspace_root / 'cache',
            self.workspace_root / 'home',
            self.sessions_root,
        ):
            directory.mkdir(mode=0o750, parents=True, exist_ok=True)

    @property
    def sessions_root(self) -> Path:
        return self.workspace_root / 'sessions'
