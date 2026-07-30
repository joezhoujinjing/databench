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
from urllib.parse import urlsplit

import httpx

from .archive import package_result_archive
from .config import EVALSCOPE_COMMIT, RuntimeConfig
from .errors import RuntimePolicyError, UpstreamProtocolError
from .storage import TaskManifestStore

_DIGEST = re.compile(r'^[0-9a-f]{64}$')
_RUN_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
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


@dataclass(frozen=True)
class ResolvedModelDeployment:
    deployment_id: str
    artifact_id: str
    create_digest: str
    served_model_name: str
    endpoint_base_url: str
    base_model_reference: str
    base_model_revision: str

    @classmethod
    def parse(cls, value: Any, expected_id: str) -> 'ResolvedModelDeployment':
        expected_fields = {
            'id',
            'artifact_id',
            'create_digest',
            'provider',
            'registration_mode',
            'served_model_name',
            'endpoint_base_url',
            'auth_mode',
            'base_model_reference',
            'base_model_revision',
        }
        if not isinstance(value, dict) or set(value) != expected_fields:
            raise UpstreamProtocolError('Databench returned an invalid Model Deployment')
        if (
            value.get('id') != expected_id
            or not _UUID.fullmatch(expected_id)
            or not isinstance(value.get('artifact_id'), str)
            or not _UUID.fullmatch(value['artifact_id'])
            or not isinstance(value.get('create_digest'), str)
            or not _DIGEST.fullmatch(value['create_digest'])
            or value.get('provider') != 'openai_compatible'
            or value.get('registration_mode') != 'operator_attested'
            or value.get('auth_mode') != 'none'
        ):
            raise UpstreamProtocolError('Databench returned an invalid Model Deployment')
        served_model_name = _bounded_optional_string(value.get('served_model_name'), 'served_model_name')
        endpoint_base_url = _bounded_optional_string(value.get('endpoint_base_url'), 'endpoint_base_url', 2_048)
        base_model_reference = _bounded_optional_string(value.get('base_model_reference'), 'base_model_reference')
        base_model_revision = _bounded_optional_string(value.get('base_model_revision'), 'base_model_revision')
        if None in (served_model_name, endpoint_base_url, base_model_reference, base_model_revision):
            raise UpstreamProtocolError('Databench returned an invalid Model Deployment')
        parsed_endpoint = urlsplit(endpoint_base_url)
        if (
            parsed_endpoint.scheme not in {'http', 'https'}
            or not parsed_endpoint.hostname
            or parsed_endpoint.username is not None
            or parsed_endpoint.password is not None
            or parsed_endpoint.query
            or parsed_endpoint.fragment
        ):
            raise UpstreamProtocolError('Databench returned an invalid Model Deployment endpoint')
        return cls(
            deployment_id=expected_id,
            artifact_id=value['artifact_id'],
            create_digest=value['create_digest'],
            served_model_name=served_model_name,
            endpoint_base_url=endpoint_base_url,
            base_model_reference=base_model_reference,
            base_model_revision=base_model_revision,
        )


class DatabenchClient:
    """Small internal client that never accepts a caller-provided origin or path."""

    def __init__(
        self,
        config: RuntimeConfig,
        manifests: TaskManifestStore,
        *,
        client: httpx.Client | None = None,
        uploader: httpx.Client | None = None,
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
        self._uploader = uploader

    def prepare_evaluation(
        self,
        task_id: str,
        payload: dict[str, Any],
        source: DatabenchSource,
        deployment: ResolvedModelDeployment | None = None,
        scoring_config: dict[str, Any] | None = None,
    ) -> PreparedDatabenchEvaluation:
        model_name = (
            deployment.served_model_name
            if deployment is not None
            else _bounded_optional_string(payload.get('model'), 'model')
        )
        integration = {
            'schema_version': (
                4
                if deployment is not None and scoring_config is not None
                else 3
                if scoring_config is not None
                else 2
                if deployment is not None
                else 1
            ),
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
        if scoring_config is not None:
            integration['scoring_config'] = scoring_config
        if deployment is not None:
            integration.update({
                'model_deployment_id': deployment.deployment_id,
                'model_artifact_id': deployment.artifact_id,
                'model_deployment_digest': deployment.create_digest,
            })
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

        create_body = {
            'provider': 'evalscope',
            'provider_task_id': task_id,
            'dataset_version': source.dataset_version,
            'source_ref': source.source_ref,
            'converter': source.converter,
            'converter_options': source.options,
            'accepted_fidelity_digest': source.accepted_fidelity_digest,
            'model_name': None if deployment is not None else model_name,
            'evalscope_commit': EVALSCOPE_COMMIT,
        }
        if scoring_config is not None:
            create_body['scoring_config'] = scoring_config
        if deployment is not None:
            create_body['model_deployment_id'] = deployment.deployment_id
        run = self._json_request(
            'POST',
            '/v2/evaluation-runs',
            create_body,
            expected_status=201,
            retry_transport_once=True,
        )
        run_id = run.get('id')
        if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id) or run.get('status') != 'prepared':
            raise UpstreamProtocolError('Databench returned an invalid evaluation run')
        if deployment is not None and (
            run.get('model_deployment_id') != deployment.deployment_id
            or run.get('model_artifact_id') != deployment.artifact_id
            or run.get('model_name') != deployment.served_model_name
        ):
            raise UpstreamProtocolError('Databench returned mismatched Model Deployment lineage')
        self._manifests.update_integration(task_id, {'run_id': run_id})

        input_file = self._export(task_id, source)
        injected = copy.deepcopy(payload)
        injected.pop('databench_source', None)
        injected.pop('databench_deployment_id', None)
        injected['datasets'] = ['general_qa']
        dataset_args = injected.setdefault('dataset_args', {})
        if not isinstance(dataset_args, dict):
            raise RuntimePolicyError('task_config_invalid', 'dataset_args must be an object', 422, '/dataset_args')
        general_qa_args = dataset_args.setdefault('general_qa', {})
        if not isinstance(general_qa_args, dict):
            raise RuntimePolicyError(
                'task_config_invalid',
                'general_qa dataset_args must be an object',
                422,
                '/dataset_args/general_qa',
            )
        general_qa_args.update({
            'local_path': str(input_file.parent),
            'subset_list': ['databench'],
        })
        return PreparedDatabenchEvaluation(payload=injected, run_id=run_id, input_file=input_file)

    def resolve_model_deployment(self, deployment_id: str) -> ResolvedModelDeployment:
        if not isinstance(deployment_id, str) or not _UUID.fullmatch(deployment_id):
            raise RuntimePolicyError(
                'model_deployment_invalid',
                'Databench Model Deployment ID is invalid',
                422,
                '/databench_deployment_id',
            )
        value = self._json_request(
            'GET',
            f'/internal/v1/model-deployments/{deployment_id}:resolve',
        )
        return ResolvedModelDeployment.parse(value, deployment_id)

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
            scoring_config = integration.get('scoring_config')
            if isinstance(scoring_config, dict):
                body.update({
                    'scoring_config': scoring_config,
                    'primary_metric_id': scoring_config.get('primary_metric_id'),
                    'primary_output_key': scoring_config.get('primary_output_key'),
                })
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
        if result.get('id') != run_id or result.get('status') != status:
            return False
        if status != 'completed':
            return True
        try:
            return self._archive_completed_result(
                task_id=str(integration.get('task_id')),
                run_id=run_id,
                provider_report_ids=body['provider_report_ids'],
            )
        except RuntimePolicyError as error:
            if error.code not in {
                'archive_secret_detected',
                'archive_path_invalid',
                'archive_file_invalid',
                'archive_too_large',
            }:
                return False
            return self._fail_archive(run_id, error)

    def _archive_completed_result(
        self,
        *,
        task_id: str,
        run_id: str,
        provider_report_ids: list[str],
    ) -> bool:
        prepared = self._json_request(
            'POST',
            f'/v2/evaluation-runs/{run_id}:prepare-result-upload',
            {},
        )
        parsed = self._validate_archive_prepare(prepared, run_id)
        if parsed['archive_status'] == 'available':
            return True
        attempt = parsed['archive_attempt']
        upload = parsed['upload']
        max_bytes = min(upload['max_size_bytes'], self._config.archive_max_bytes)
        archive = package_result_archive(
            self._config.output_dir / task_id,
            task_id=task_id,
            run_id=run_id,
            provider_report_ids=provider_report_ids,
            max_bytes=max_bytes,
        )
        try:
            uploaded = self._put_archive(upload, archive.path, archive.size)
            if not uploaded:
                refreshed = self._json_request(
                    'POST',
                    f'/v2/evaluation-runs/{run_id}:prepare-result-upload',
                    {},
                )
                parsed = self._validate_archive_prepare(refreshed, run_id)
                if parsed['archive_status'] == 'available':
                    return True
                if parsed['archive_attempt'] != attempt:
                    raise UpstreamProtocolError('Databench changed an active archive attempt')
                if not self._put_archive(parsed['upload'], archive.path, archive.size):
                    raise RuntimePolicyError(
                        'archive_upload_unavailable',
                        'Evaluation archive upload could not be confirmed',
                        503,
                    )
            finalized = self._json_request(
                'POST',
                f'/v2/evaluation-runs/{run_id}:finalize-result-upload',
                {
                    'archive_attempt': attempt,
                    'digest': archive.digest,
                    'size_bytes': archive.size,
                },
                retry_transport_once=True,
            )
            return (
                finalized.get('id') == run_id
                and finalized.get('archive_status') == 'available'
                and finalized.get('archive_attempt') == attempt
                and finalized.get('result_artifact_digest') == archive.digest
                and finalized.get('result_artifact_size_bytes') == archive.size
            )
        finally:
            archive.cleanup()

    def _put_archive(self, upload: dict[str, Any], path: Path, size: int) -> bool:
        headers = dict(upload['required_headers'])
        headers['content-length'] = str(size)
        try:
            if self._uploader is None:
                with httpx.Client(
                    follow_redirects=False,
                    timeout=httpx.Timeout(120.0, connect=10.0),
                    trust_env=False,
                ) as uploader, path.open('rb') as source:
                    response = uploader.put(upload['url'], headers=headers, content=source)
            else:
                with path.open('rb') as source:
                    response = self._uploader.put(upload['url'], headers=headers, content=source)
        except (OSError, httpx.HTTPError):
            return False
        if 300 <= response.status_code < 400 or response.headers.get('location'):
            raise RuntimePolicyError(
                'archive_upload_redirect_rejected',
                'Evaluation archive upload redirect was rejected',
                502,
            )
        if response.status_code == 412:
            return True
        return response.status_code in {200, 201, 204}

    def _validate_archive_prepare(self, value: dict[str, Any], run_id: str) -> dict[str, Any]:
        if set(value) != {'run_id', 'archive_status', 'archive_attempt', 'upload'}:
            raise UpstreamProtocolError('Databench archive preparation response is invalid')
        attempt = value.get('archive_attempt')
        status = value.get('archive_status')
        upload = value.get('upload')
        if value.get('run_id') != run_id or not isinstance(attempt, int) or attempt <= 0:
            raise UpstreamProtocolError('Databench archive preparation response is invalid')
        if status == 'available' and upload is None:
            return value
        if status != 'uploading' or not isinstance(upload, dict):
            raise UpstreamProtocolError('Databench archive preparation response is invalid')
        required_headers = upload.get('required_headers')
        max_size = upload.get('max_size_bytes')
        url = upload.get('url')
        if (
            set(upload)
            != {'method', 'url', 'expires_at', 'content_type', 'required_headers', 'max_size_bytes'}
            or upload.get('method') != 'PUT'
            or upload.get('content_type') != 'application/zstd'
            or required_headers
            != {'content-type': 'application/zstd', 'if-none-match': '*'}
            or not isinstance(max_size, int)
            or max_size <= 0
            or not isinstance(url, str)
            or not url.startswith(('http://', 'https://'))
        ):
            raise UpstreamProtocolError('Databench archive upload descriptor is invalid')
        return value

    def _fail_archive(self, run_id: str, error: RuntimePolicyError) -> bool:
        try:
            current = self._json_request('GET', f'/v2/evaluation-runs/{run_id}')
            attempt = current.get('archive_attempt')
            if not isinstance(attempt, int) or attempt <= 0:
                return False
            failed = self._json_request(
                'POST',
                f'/v2/evaluation-runs/{run_id}:fail-result-upload',
                {
                    'archive_attempt': attempt,
                    'error': {
                        'phase': 'provider_archive',
                        'code': error.code,
                        'message': 'EvalScope result archive was rejected by the archive policy',
                    },
                },
                retry_transport_once=True,
            )
        except RuntimePolicyError:
            return False
        return failed.get('id') == run_id and failed.get('archive_status') == 'failed'

    def _ensure_run_id(self, integration: dict[str, Any]) -> str:
        existing = integration.get('run_id')
        if isinstance(existing, str) and _RUN_ID.fullmatch(existing):
            return existing
        task_id = integration.get('task_id')
        if not isinstance(task_id, str):
            raise RuntimePolicyError('task_integration_invalid', 'Task integration ID is invalid', 500)
        create_body = {
            'provider': 'evalscope',
            'provider_task_id': task_id,
            'dataset_version': integration.get('dataset_version'),
            'source_ref': integration.get('source_ref'),
            'converter': integration.get('converter'),
            'converter_options': integration.get('options'),
            'accepted_fidelity_digest': integration.get('accepted_fidelity_digest'),
            'model_name': (
                None
                if integration.get('schema_version') in {2, 4}
                else integration.get('model_name')
            ),
            'evalscope_commit': integration.get('evalscope_commit'),
        }
        scoring_config = integration.get('scoring_config')
        if isinstance(scoring_config, dict):
            create_body['scoring_config'] = scoring_config
        if integration.get('schema_version') in {2, 4}:
            create_body['model_deployment_id'] = integration.get('model_deployment_id')
        run = self._json_request(
            'POST',
            '/v2/evaluation-runs',
            create_body,
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


def _bounded_optional_string(value: Any, field: str, maximum: int = 512) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > maximum:
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
