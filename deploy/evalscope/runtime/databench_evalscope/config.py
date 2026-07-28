"""Fail-closed runtime configuration."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from .errors import RuntimePolicyError

EVALSCOPE_COMMIT = 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60'
PLOTLY_SHA256 = '6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603'


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimePolicyError('invalid_runtime_config', f'{name} must be an integer', 500) from exc
    if value <= 0:
        raise RuntimePolicyError('invalid_runtime_config', f'{name} must be positive', 500)
    return value


def _bounded_nonnegative_int(env: Mapping[str, str], name: str, default: int, maximum: int) -> int:
    raw = env.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimePolicyError('invalid_runtime_config', f'{name} must be an integer', 500) from exc
    if value < 0 or value > maximum:
        raise RuntimePolicyError(
            'invalid_runtime_config',
            f'{name} must be between 0 and {maximum}',
            500,
        )
    return value


def _absolute_path(env: Mapping[str, str], name: str) -> Path:
    raw = env.get(name, '').strip()
    if not raw:
        raise RuntimePolicyError('invalid_runtime_config', f'{name} is required', 500)
    path = Path(raw)
    if not path.is_absolute():
        raise RuntimePolicyError('invalid_runtime_config', f'{name} must be absolute', 500)
    return path.resolve(strict=False)


def _secret(env: Mapping[str, str], name: str) -> bytes:
    value = env.get(name, '').encode('utf-8')
    if len(value) < 32:
        raise RuntimePolicyError(
            'invalid_runtime_config',
            f'{name} must contain at least 32 UTF-8 bytes',
            500,
        )
    return value


def _optional_credential(env: Mapping[str, str]) -> str | None:
    value = env.get('DATABENCH_SERVICE_CREDENTIAL', '').strip()
    if not value:
        return None
    if len(value.encode('utf-8')) > 4096 or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value):
        raise RuntimePolicyError('invalid_runtime_config', 'DATABENCH_SERVICE_CREDENTIAL is invalid', 500)
    return value


def _service_base_url(env: Mapping[str, str]) -> str:
    raw = env.get('DATABENCH_BASE_URL', '').strip()
    parsed = urlsplit(raw)
    if (
        parsed.scheme not in {'http', 'https'}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {'', '/'}
    ):
        raise RuntimePolicyError(
            'invalid_runtime_config',
            'DATABENCH_BASE_URL must be an HTTP(S) origin without credentials or a path',
            500,
        )
    return raw.rstrip('/')


def _origin(env: Mapping[str, str]) -> str:
    raw = env.get('DATABENCH_ORIGIN', '').strip()
    parsed = urlsplit(raw)
    if (
        parsed.scheme not in {'http', 'https'}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {'', '/'}
    ):
        raise RuntimePolicyError(
            'invalid_runtime_config',
            'DATABENCH_ORIGIN must be an HTTP(S) origin',
            500,
        )
    return raw.rstrip('/')


@dataclass(frozen=True)
class RuntimeConfig:
    output_dir: Path
    input_dir: Path
    allowed_media_roots: tuple[Path, ...]
    task_hmac_key: bytes
    operator_token: bytes
    databench_base_url: str
    databench_service_credential: str | None
    databench_origin: str
    plotly_asset_path: Path
    plotly_asset_sha256: str
    endpoint_allowlist: str
    model_redirect_max_hops: int
    input_max_bytes: int
    output_max_bytes: int
    request_max_bytes: int
    response_max_bytes: int
    document_max_bytes: int
    document_ttl_seconds: int
    max_concurrent_evals: int
    max_concurrent_perf: int
    max_tasks: int

    @classmethod
    def from_env(cls, source: Mapping[str, str] | None = None) -> 'RuntimeConfig':
        env = os.environ if source is None else source
        if env.get('EVALSCOPE_SERVE_WEB', 'false').lower() != 'false':
            raise RuntimePolicyError(
                'invalid_runtime_config',
                'EVALSCOPE_SERVE_WEB must be false in Databench runtime',
                500,
            )

        output_dir = _absolute_path(env, 'EVALSCOPE_OUTPUT_DIR')
        input_dir = _absolute_path(env, 'EVALSCOPE_INPUT_DIR')
        if output_dir == input_dir or output_dir in input_dir.parents or input_dir in output_dir.parents:
            raise RuntimePolicyError(
                'invalid_runtime_config',
                'EvalScope input and output roots must be distinct and non-nested',
                500,
            )

        roots_raw = env.get('EVALSCOPE_ALLOWED_MEDIA_ROOTS', '').split(',')
        configured_roots = tuple(Path(value.strip()) for value in roots_raw if value.strip())
        if any(not root.is_absolute() for root in configured_roots):
            raise RuntimePolicyError(
                'invalid_runtime_config',
                'Every media root must be an absolute path',
                500,
            )
        media_roots = tuple(root.resolve(strict=False) for root in configured_roots)
        if not media_roots:
            media_roots = (output_dir, input_dir)
        for root in media_roots:
            if not root.is_absolute() or not any(
                root == allowed or allowed in root.parents for allowed in (output_dir, input_dir)
            ):
                raise RuntimePolicyError(
                    'invalid_runtime_config',
                    'Every media root must be contained by the configured input or output root',
                    500,
                )

        plotly_path = _absolute_path(env, 'EVALSCOPE_PLOTLY_ASSET_PATH')
        plotly_digest = env.get('EVALSCOPE_PLOTLY_ASSET_SHA256', '').strip().lower()
        if plotly_digest != PLOTLY_SHA256:
            raise RuntimePolicyError(
                'invalid_runtime_config',
                'The Plotly asset digest does not match the pinned runtime digest',
                500,
            )

        redirect_max_hops = _bounded_nonnegative_int(
            env,
            'EVALSCOPE_MODEL_REDIRECT_MAX_HOPS',
            0,
            5,
        )
        if redirect_max_hops != 0:
            raise RuntimePolicyError(
                'invalid_runtime_config',
                'EVALSCOPE_MODEL_REDIRECT_MAX_HOPS must remain 0 until redirect forwarding is supported',
                500,
            )

        config = cls(
            output_dir=output_dir,
            input_dir=input_dir,
            allowed_media_roots=media_roots,
            task_hmac_key=_secret(env, 'EVALSCOPE_TASK_CONFIG_HMAC_KEY'),
            operator_token=_secret(env, 'EVALSCOPE_OPERATOR_TOKEN'),
            databench_base_url=_service_base_url(env),
            databench_service_credential=_optional_credential(env),
            databench_origin=_origin(env),
            plotly_asset_path=plotly_path,
            plotly_asset_sha256=plotly_digest,
            endpoint_allowlist=env.get('EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST', '').strip(),
            model_redirect_max_hops=redirect_max_hops,
            input_max_bytes=_positive_int(env, 'EVALSCOPE_INPUT_MAX_BYTES', 1_073_741_824),
            output_max_bytes=_positive_int(env, 'EVALSCOPE_OUTPUT_MAX_BYTES', 4_294_967_296),
            request_max_bytes=_positive_int(env, 'EVALSCOPE_REQUEST_MAX_BYTES', 1_048_576),
            response_max_bytes=_positive_int(env, 'EVALSCOPE_RESPONSE_MAX_BYTES', 16_777_216),
            document_max_bytes=_positive_int(env, 'EVALSCOPE_DOCUMENT_MAX_BYTES', 16_777_216),
            document_ttl_seconds=_positive_int(env, 'EVALSCOPE_DOCUMENT_TTL_SECONDS', 900),
            max_concurrent_evals=_positive_int(env, 'EVALSCOPE_MAX_CONCURRENT_EVALS', 2),
            max_concurrent_perf=_positive_int(env, 'EVALSCOPE_MAX_CONCURRENT_PERF', 2),
            max_tasks=_positive_int(env, 'EVALSCOPE_MAX_TASKS', 10_000),
        )
        return config

    def prepare(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
        self.input_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
        for root in self.allowed_media_roots:
            root.mkdir(parents=True, exist_ok=True, mode=0o750)
        if not self.plotly_asset_path.is_file():
            raise RuntimePolicyError('invalid_runtime_config', 'Pinned Plotly asset is missing', 500)
        digest = hashlib.sha256(self.plotly_asset_path.read_bytes()).hexdigest()
        if digest != self.plotly_asset_sha256:
            raise RuntimePolicyError('invalid_runtime_config', 'Pinned Plotly asset is corrupted', 500)
