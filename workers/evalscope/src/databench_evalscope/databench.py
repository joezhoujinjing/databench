"""Exact-version Databench export and evaluation-run callbacks."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .config import EVALSCOPE_COMMIT, RuntimeConfig
from .errors import RuntimePolicyError, UpstreamProtocolError
from .storage import TaskManifestStore

_DIGEST = re.compile(r'^[0-9a-f]{64}$')
_RUN_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
_REF = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$')
_TARGET_SOURCES = {'selected-candidate', 'verification-ground-truth', 'none'}


@dataclass(frozen=True)
class DatabenchSource:
    source_ref: str | None
    dataset_version: str
    converter: str
    options: dict[str, str]
    accepted_fidelity_digest: str

    @classmethod
    def parse(cls, value: Any) -> 'DatabenchSource':
        if not isinstance(value, dict) or set(value) != {
            'source_ref',
            'dataset_version',
            'converter',
            'options',
            'accepted_fidelity_digest',
        }:
            raise RuntimePolicyError(
                'databench_source_invalid',
                'databench_source must use the exact integration schema',
                422,
                '/databench_source',
            )
        dataset_version = value.get('dataset_version')
        accepted = value.get('accepted_fidelity_digest')
        if not isinstance(dataset_version, str) or not _DIGEST.fullmatch(dataset_version):
            raise RuntimePolicyError(
                'databench_source_invalid',
                'dataset_version must be an exact 64-character digest',
                422,
                '/databench_source/dataset_version',
            )
        if not isinstance(accepted, str) or not _DIGEST.fullmatch(accepted):
            raise RuntimePolicyError(
                'databench_source_invalid',
                'accepted_fidelity_digest must be an exact digest',
                422,
                '/databench_source/accepted_fidelity_digest',
            )
        source_ref = value.get('source_ref')
        if source_ref is not None and (
            not isinstance(source_ref, str)
            or not _REF.fullmatch(source_ref)
            or '..' in source_ref.split('/')
        ):
            raise RuntimePolicyError(
                'databench_source_invalid',
                'source_ref is invalid',
                422,
                '/databench_source/source_ref',
            )
        options = value.get('options')
        if (
            not isinstance(options, dict)
            or set(options) != {'target_source'}
            or options.get('target_source') not in _TARGET_SOURCES
        ):
            raise RuntimePolicyError(
                'databench_source_invalid',
                'Only the general_qa target_source option is supported',
                422,
                '/databench_source/options',
            )
        if value.get('converter') != 'evalscope-general-qa':
            raise RuntimePolicyError(
                'databench_source_invalid',
                'Only evalscope-general-qa is supported',
                422,
                '/databench_source/converter',
            )
        return cls(
            source_ref=source_ref,
            dataset_version=dataset_version,
            converter='evalscope-general-qa',
            options={'target_source': options['target_source']},
            accepted_fidelity_digest=accepted,
        )


@dataclass(frozen=True)
class PreparedDatabenchEvaluation:
    payload: dict[str, Any]
    run_id: str
    input_file: Path


class DatabenchClient:
    """Small internal client that never accepts a caller-provided origin or path."""

    def __init__(
        self,
        config: RuntimeConfig,
        manifests: TaskManifestStore,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self._config = config
        self._manifests = manifests
        headers = {'Accept': 'application/json'}
        if config.databench_service_credential is not None:
            headers['Authorization'] = f'Bearer {config.databench_service_credential}'
        self._client = client or httpx.Client(
            base_url=config.databench_base_url,
            headers=headers,
            follow_redirects=False,
            timeout=httpx.Timeout(60.0, connect=10.0),
            trust_env=False,
        )

    def prepare_evaluation(
        self,
        task_id: str,
        payload: dict[str, Any],
        source: DatabenchSource,
    ) -> PreparedDatabenchEvaluation:
        model_name = _bounded_optional_string(payload.get('model'), 'model')
        integration = {
            'schema_version': 1,
            'task_id': task_id,
            'run_id': None,
            'source_ref': source.source_ref,
            'dataset_version': source.dataset_version,
            'converter': source.converter,
            'options': source.options,
            'accepted_fidelity_digest': source.accepted_fidelity_digest,
            'model_name': model_name,
            'evalscope_commit': EVALSCOPE_COMMIT,
            'input_filename': 'databench.jsonl',
        }
        self._manifests.write_integration(task_id, integration)

        described = self._json_request('GET', f'/v2/datasets/{source.dataset_version}')
        if (
            described.get('requested_ref') != source.dataset_version
            or described.get('dataset_version') != source.dataset_version
            or described.get('ref_name') is not None
        ):
            raise UpstreamProtocolError('Databench did not return the requested exact Dataset version')

        inspect_body = {'converter': source.converter, 'options': source.options}
        plan = self._json_request(
            'POST',
            f'/v2/datasets/{source.dataset_version}:inspect-export',
            inspect_body,
        )
        self._validate_plan(plan, source)

        run = self._json_request(
            'POST',
            '/v2/evaluation-runs',
            {
                'provider': 'evalscope',
                'provider_task_id': task_id,
                'dataset_version': source.dataset_version,
                'source_ref': source.source_ref,
                'converter': source.converter,
                'converter_options': source.options,
                'accepted_fidelity_digest': source.accepted_fidelity_digest,
                'model_name': model_name,
                'evalscope_commit': EVALSCOPE_COMMIT,
            },
            expected_status=201,
            retry_transport_once=True,
        )
        run_id = run.get('id')
        if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id) or run.get('status') != 'prepared':
            raise UpstreamProtocolError('Databench returned an invalid evaluation run')
        self._manifests.update_integration(task_id, {'run_id': run_id})

        input_file = self._export(task_id, source)
        injected = copy.deepcopy(payload)
        injected.pop('databench_source', None)
        injected['datasets'] = ['general_qa']
        injected['dataset_args'] = {
            'general_qa': {
                'local_path': str(input_file.parent),
                'subset_list': ['databench'],
            }
        }
        return PreparedDatabenchEvaluation(payload=injected, run_id=run_id, input_file=input_file)

    def start(self, run_id: str) -> bool:
        result = self._json_request('POST', f'/v2/evaluation-runs/{run_id}:start', {})
        return result.get('id') == run_id and result.get('status') == 'running'

    def callback(self, manifest: dict[str, Any], integration: dict[str, Any]) -> bool:
        terminal = manifest.get('terminal')
        if not isinstance(terminal, dict):
            return False
        status = terminal.get('status')
        if status == 'completed':
            body = {
                'metrics': terminal.get('metrics') or [],
                'provider_report_ids': terminal.get('provider_report_ids') or [],
            }
        elif status in {'failed', 'cancelled'}:
            body = {'error': terminal.get('error')}
        else:
            return False
        try:
            run_id = self._ensure_run_id(integration)
            suffix = {'completed': 'complete', 'failed': 'fail', 'cancelled': 'cancel'}[status]
            result = self._json_request(
                'POST',
                f'/v2/evaluation-runs/{run_id}:{suffix}',
                body,
            )
        except RuntimePolicyError:
            return False
        return result.get('id') == run_id and result.get('status') == status

    def _ensure_run_id(self, integration: dict[str, Any]) -> str:
        existing = integration.get('run_id')
        if isinstance(existing, str) and _RUN_ID.fullmatch(existing):
            return existing
        task_id = integration.get('task_id')
        if not isinstance(task_id, str):
            raise RuntimePolicyError('task_integration_invalid', 'Task integration ID is invalid', 500)
        run = self._json_request(
            'POST',
            '/v2/evaluation-runs',
            {
                'provider': 'evalscope',
                'provider_task_id': task_id,
                'dataset_version': integration.get('dataset_version'),
                'source_ref': integration.get('source_ref'),
                'converter': integration.get('converter'),
                'converter_options': integration.get('options'),
                'accepted_fidelity_digest': integration.get('accepted_fidelity_digest'),
                'model_name': integration.get('model_name'),
                'evalscope_commit': integration.get('evalscope_commit'),
            },
            expected_status=201,
            retry_transport_once=True,
        )
        run_id = run.get('id')
        if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id):
            raise UpstreamProtocolError('Databench returned an invalid evaluation run')
        self._manifests.update_integration(task_id, {'run_id': run_id})
        return run_id

    def _export(self, task_id: str, source: DatabenchSource) -> Path:
        task_dir = self._config.input_dir / task_id
        created = False
        try:
            task_dir.mkdir(mode=0o750)
            created = True
        except FileExistsError:
            if task_dir.is_symlink() or not task_dir.is_dir():
                raise RuntimePolicyError('input_staging_invalid', 'Input staging directory is invalid', 500)
        if created:
            _fsync_directory(self._config.input_dir)
        final = task_dir / 'databench.jsonl'
        partial = task_dir / f'.databench.jsonl.{uuid.uuid4().hex}.partial'
        body = {
            'converter': source.converter,
            'options': source.options,
            'accepted_fidelity_digest': source.accepted_fidelity_digest,
        }
        total = 0
        try:
            with self._client.stream(
                'POST',
                f'/v2/datasets/{source.dataset_version}:export',
                json=body,
            ) as response:
                self._assert_no_redirect(response)
                if response.status_code != 200:
                    raise RuntimePolicyError(
                        'databench_export_failed',
                        'Databench Dataset export failed',
                        502,
                    )
                media_type = response.headers.get('content-type', '').split(';', 1)[0].lower()
                if media_type != 'application/x-ndjson':
                    raise UpstreamProtocolError('Databench export returned an unexpected media type')
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
                fd = os.open(partial, flags, 0o600)
                try:
                    for chunk in response.iter_bytes():
                        total += len(chunk)
                        if total > self._config.input_max_bytes:
                            raise RuntimePolicyError(
                                'databench_export_too_large',
                                'Databench Dataset export exceeds the configured input bound',
                                413,
                            )
                        _write_all(fd, chunk)
                    os.fsync(fd)
                finally:
                    os.close(fd)
            if total == 0:
                raise UpstreamProtocolError('Databench export returned an empty body')
            if final.exists():
                if final.is_symlink() or final.stat().st_nlink != 1:
                    raise RuntimePolicyError('input_staging_invalid', 'Input staging file is invalid', 500)
                if final.stat().st_size != partial.stat().st_size or _sha256_file(final) != _sha256_file(partial):
                    raise RuntimePolicyError('input_staging_conflict', 'Input staging already differs', 409)
                partial.unlink()
            else:
                os.replace(partial, final)
                _fsync_directory(task_dir)
            return final
        except Exception:
            partial.unlink(missing_ok=True)
            raise

    def _json_request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        expected_status: int = 200,
        retry_transport_once: bool = False,
    ) -> dict[str, Any]:
        attempts = 2 if retry_transport_once else 1
        response: httpx.Response | None = None
        for attempt in range(attempts):
            try:
                kwargs = {} if body is None else {'json': body}
                response = self._client.request(method, path, **kwargs)
                break
            except httpx.HTTPError as exc:
                if attempt + 1 == attempts:
                    raise RuntimePolicyError(
                        'databench_unavailable',
                        'Databench internal API is unavailable',
                        503,
                    ) from exc
        if response is None:
            raise RuntimePolicyError('databench_unavailable', 'Databench internal API is unavailable', 503)
        self._assert_no_redirect(response)
        if response.status_code != expected_status:
            raise RuntimePolicyError(
                'databench_request_failed',
                'Databench rejected the evaluation integration request',
                502,
            )
        if len(response.content) > self._config.response_max_bytes:
            raise UpstreamProtocolError('Databench response exceeds its configured bound')
        try:
            value = response.json()
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UpstreamProtocolError() from exc
        if not isinstance(value, dict):
            raise UpstreamProtocolError()
        return value

    @staticmethod
    def _assert_no_redirect(response: httpx.Response) -> None:
        if 300 <= response.status_code < 400 or response.headers.get('location'):
            raise RuntimePolicyError(
                'databench_redirect_rejected',
                'Databench internal API redirects are not allowed',
                502,
            )

    @staticmethod
    def _validate_plan(plan: dict[str, Any], source: DatabenchSource) -> None:
        hints = plan.get('config_hints')
        if (
            plan.get('dataset_version') != source.dataset_version
            or plan.get('converter') != source.converter
            or plan.get('converter_version') != '1.0.0'
            or plan.get('normalized_options') != source.options
            or plan.get('media_type') != 'application/x-ndjson'
            or plan.get('fidelity_digest') != source.accepted_fidelity_digest
            or not isinstance(hints, dict)
            or not isinstance(hints.get('evalscope'), dict)
            or hints['evalscope'].get('benchmark') != 'general_qa'
            or hints['evalscope'].get('subset') != 'databench'
        ):
            raise RuntimePolicyError(
                'databench_fidelity_mismatch',
                'Databench export plan no longer matches the accepted fidelity plan',
                409,
            )


def _bounded_optional_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > 512:
        raise RuntimePolicyError('task_config_invalid', f'{field} is invalid', 422, f'/{field}')
    return value


def _write_all(fd: int, raw: bytes) -> None:
    offset = 0
    while offset < len(raw):
        written = os.write(fd, raw[offset:])
        if written <= 0:
            raise OSError('short write')
        offset += written


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()
