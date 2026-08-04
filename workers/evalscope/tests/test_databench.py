from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from databench_evalscope.databench import (
    DatabenchClient,
    DatabenchSource,
    ResolvedModelArtifactSource,
    ResolvedModelDeclaredCapabilities,
    ResolvedModelDeployment,
    ResolvedModelRepositorySource,
    ResolvedModelServiceSource,
    ResolvedModelVersionDeployment,
)
from databench_evalscope.errors import RuntimePolicyError, UpstreamProtocolError
from databench_evalscope.storage import TaskManifestStore, config_digest

TASK_ID = 'eval_123e4567-e89b-42d3-a456-426614174000'
RUN_ID = '123e4567-e89b-42d3-a456-426614174099'
VERSION = 'a' * 64
FIDELITY = 'b' * 64
MODEL_ID = '423e4567-e89b-42d3-a456-426614174000'
MODEL_VERSION_ID = '523e4567-e89b-42d3-a456-426614174000'
MODEL_VERSION_DEPLOYMENT_ID = '623e4567-e89b-42d3-a456-426614174000'
MODEL_ARTIFACT_ID = '723e4567-e89b-42d3-a456-426614174000'


def source() -> DatabenchSource:
    return DatabenchSource.parse({
        'source_ref': 'support-qa',
        'dataset_version': VERSION,
        'converter': 'evalscope-general-qa',
        'options': {'target_source': 'none'},
        'accepted_fidelity_digest': FIDELITY,
    })


def archive_prepare(url: str) -> dict[str, Any]:
    return {
        'run_id': RUN_ID,
        'archive_status': 'uploading',
        'archive_attempt': 1,
        'upload': {
            'method': 'PUT',
            'url': url,
            'expires_at': '2026-07-28T00:15:00.000Z',
            'content_type': 'application/zstd',
            'required_headers': {
                'content-type': 'application/zstd',
                'if-none-match': '*',
            },
            'max_size_bytes': 1024 * 1024 * 1024,
        },
    }


def resolved_model_version_deployment(source_kind: str) -> dict[str, Any]:
    artifact_id: str | None
    source_value: dict[str, Any]
    if source_kind == 'databench_artifact':
        artifact_id = MODEL_ARTIFACT_ID
        source_value = {
            'kind': 'databench_artifact',
            'artifact_id': MODEL_ARTIFACT_ID,
            'artifact_kind': 'lora_adapter',
            'artifact_format': 'swift-lora-adapter-v1',
            'archive_digest': '3' * 64,
            'manifest_digest': '4' * 64,
        }
    elif source_kind == 'repository_reference':
        artifact_id = None
        source_value = {
            'kind': 'repository_reference',
            'provider': 'modelscope',
            'repository_id': 'Qwen/Qwen3-0.6B',
            'revision': '0123456789abcdef',
            'revision_kind': 'commit',
        }
    else:
        artifact_id = None
        source_value = {
            'kind': 'existing_service',
            'provider': 'openai_compatible',
            'external_model_ref': 'Qwen/Qwen3-0.6B',
            'external_version_ref': 'service-release-2026-08-05',
            'declared_reference_kind': 'immutable_version',
        }
    return {
        'id': MODEL_VERSION_DEPLOYMENT_ID,
        'model_id': MODEL_ID,
        'model_version_id': MODEL_VERSION_ID,
        'create_digest': '1' * 64,
        'source_fingerprint': '2' * 64,
        'source_kind': source_kind,
        'artifact_id': artifact_id,
        'source': source_value,
        'provider': 'openai_compatible',
        'served_model_name': 'qwen-registry-route',
        'endpoint_base_url': 'http://model-service:8000/v1',
        'connectivity_scope': 'private_network',
        'auth_profile': 'bearer_ref',
        'credential_ref': 'qwen-evalscope-v1',
        'declared_capabilities': {
            'interfaces': ['chat_completions', 'tools'],
            'context_limit': 32_768,
        },
    }


@pytest.mark.parametrize(
    ('source_kind', 'source_type'),
    [
        ('databench_artifact', ResolvedModelArtifactSource),
        ('repository_reference', ResolvedModelRepositorySource),
        ('existing_service', ResolvedModelServiceSource),
    ],
)
def test_model_version_deployment_parser_has_a_strict_three_source_union(
    source_kind: str,
    source_type: type,
) -> None:
    resolved = ResolvedModelVersionDeployment.parse(
        resolved_model_version_deployment(source_kind),
        MODEL_VERSION_DEPLOYMENT_ID,
    )
    assert resolved.deployment_id == MODEL_VERSION_DEPLOYMENT_ID
    assert resolved.model_id == MODEL_ID
    assert resolved.model_version_id == MODEL_VERSION_ID
    assert resolved.source_kind == source_kind
    assert isinstance(resolved.source, source_type)
    assert resolved.artifact_id == (
        MODEL_ARTIFACT_ID if source_kind == 'databench_artifact' else None
    )
    assert resolved.auth_profile == 'bearer_ref'
    assert resolved.credential_ref == 'qwen-evalscope-v1'
    assert resolved.declared_capabilities == ResolvedModelDeclaredCapabilities(
        interfaces=('chat_completions', 'tools'),
        context_limit=32_768,
    )


@pytest.mark.parametrize(
    'invalid_case',
    [
        'extra_field',
        'deployment_id_mismatch',
        'model_id_invalid',
        'digest_invalid',
        'artifact_binding_missing',
        'artifact_binding_forbidden',
        'source_discriminator_mismatch',
        'source_shape_extra',
        'endpoint_query',
        'auth_ref_mismatch',
        'credential_ref_invalid',
        'capability_duplicate',
        'capability_context_invalid',
    ],
)
def test_model_version_deployment_parser_rejects_cross_union_and_runtime_drift(
    invalid_case: str,
) -> None:
    source_kind = 'repository_reference' if invalid_case == 'artifact_binding_forbidden' else 'databench_artifact'
    value = resolved_model_version_deployment(source_kind)
    if invalid_case == 'extra_field':
        value['secret'] = 'must-not-be-accepted'
    elif invalid_case == 'deployment_id_mismatch':
        value['id'] = MODEL_ID
    elif invalid_case == 'model_id_invalid':
        value['model_id'] = 'not-a-uuid'
    elif invalid_case == 'digest_invalid':
        value['source_fingerprint'] = 'A' * 64
    elif invalid_case == 'artifact_binding_missing':
        value['artifact_id'] = None
    elif invalid_case == 'artifact_binding_forbidden':
        value['artifact_id'] = MODEL_ARTIFACT_ID
    elif invalid_case == 'source_discriminator_mismatch':
        value['source_kind'] = 'existing_service'
    elif invalid_case == 'source_shape_extra':
        value['source']['raw_response'] = {}
    elif invalid_case == 'endpoint_query':
        value['endpoint_base_url'] = 'https://models.example/v1?api_key=secret'
    elif invalid_case == 'auth_ref_mismatch':
        value['auth_profile'] = 'none'
    elif invalid_case == 'credential_ref_invalid':
        value['credential_ref'] = '../secret'
    elif invalid_case == 'capability_duplicate':
        value['declared_capabilities']['interfaces'] = ['tools', 'tools']
    else:
        value['declared_capabilities']['context_limit'] = True

    with pytest.raises(UpstreamProtocolError):
        ResolvedModelVersionDeployment.parse(value, MODEL_VERSION_DEPLOYMENT_ID)


def test_resolves_model_version_deployment_without_switching_evaluation_execution(
    runtime_config,
) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        assert request.headers['authorization'] == (
            f'Bearer {runtime_config.databench_service_credential}'
        )
        return httpx.Response(
            200,
            json=resolved_model_version_deployment('existing_service'),
        )

    client = DatabenchClient(
        runtime_config,
        manifests,
        client=httpx.Client(
            base_url=runtime_config.databench_base_url,
            headers={
                'Authorization': f'Bearer {runtime_config.databench_service_credential}',
            },
            transport=httpx.MockTransport(handler),
        ),
    )
    resolved = client.resolve_model_version_deployment(MODEL_VERSION_DEPLOYMENT_ID)
    assert isinstance(resolved.source, ResolvedModelServiceSource)
    assert requests == [
        f'/internal/v2/model-deployments/{MODEL_VERSION_DEPLOYMENT_ID}:resolve',
    ]
    assert not (runtime_config.output_dir / TASK_ID).exists()


def test_exact_inspect_create_export_start_and_complete(runtime_config) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    manifests.claim(TASK_ID, 'evaluation', config_digest({'task': 1}, runtime_config.task_hmac_key))
    requests: list[tuple[str, str, Any]] = []
    create_attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal create_attempts
        try:
            body = json.loads(request.content) if request.content else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = {'binary_size': len(request.content)}
        requests.append((request.method, request.url.path, body))
        if request.method == 'GET' and request.url.path == f'/v2/datasets/{VERSION}':
            return httpx.Response(200, json={
                'requested_ref': VERSION,
                'ref_name': None,
                'dataset_version': VERSION,
                'manifest': {'dataset_version': VERSION},
            })
        if request.url.path == f'/v2/datasets/{VERSION}:inspect-export':
            return httpx.Response(200, json={
                'dataset_version': VERSION,
                'converter': 'evalscope-general-qa',
                'converter_version': '1.0.0',
                'normalized_options': {'target_source': 'none'},
                'media_type': 'application/x-ndjson',
                'fidelity_digest': FIDELITY,
                'config_hints': {'evalscope': {'benchmark': 'general_qa', 'subset': 'databench'}},
            })
        if request.url.path == '/v2/evaluation-runs':
            create_attempts += 1
            if create_attempts == 1:
                raise httpx.ReadError('response lost', request=request)
            return httpx.Response(201, json={'id': RUN_ID, 'status': 'prepared'})
        if request.url.path == f'/v2/datasets/{VERSION}:export':
            return httpx.Response(
                200,
                content=b'{"messages":[{"role":"user","content":"hi"}],"_databench":{"dataset_version":"' + VERSION.encode() + b'"}}\n',
                headers={'content-type': 'application/x-ndjson'},
            )
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:start':
            return httpx.Response(200, json={'id': RUN_ID, 'status': 'running'})
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:complete':
            return httpx.Response(200, json={'id': RUN_ID, 'status': 'completed'})
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:prepare-result-upload':
            return httpx.Response(200, json={
                'run_id': RUN_ID,
                'archive_status': 'uploading',
                'archive_attempt': 1,
                'upload': {
                    'method': 'PUT',
                    'url': 'https://objects.example/staging/result.tar.zst?signature=opaque',
                    'expires_at': '2026-07-28T00:15:00.000Z',
                    'content_type': 'application/zstd',
                    'required_headers': {
                        'content-type': 'application/zstd',
                        'if-none-match': '*',
                    },
                    'max_size_bytes': 1024 * 1024 * 1024,
                },
            })
        if request.url.host == 'objects.example':
            assert request.headers['if-none-match'] == '*'
            assert request.headers['content-type'] == 'application/zstd'
            return httpx.Response(200)
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:finalize-result-upload':
            return httpx.Response(200, json={
                'id': RUN_ID,
                'archive_status': 'available',
                'archive_attempt': 1,
                'result_artifact_digest': body['digest'],
                'result_artifact_size_bytes': body['size_bytes'],
            })
        raise AssertionError(f'unexpected request: {request.method} {request.url.path}')

    transport = httpx.MockTransport(handler)
    http = httpx.Client(base_url=runtime_config.databench_base_url, transport=transport)
    client = DatabenchClient(runtime_config, manifests, client=http, uploader=http)
    prepared = client.prepare_evaluation(
        TASK_ID,
        {'model': 'Qwen', 'api_url': 'http://127.0.0.1:8001/v1'},
        source(),
    )
    assert prepared.run_id == RUN_ID
    assert create_attempts == 2
    assert prepared.input_file.read_text().endswith('\n')
    assert prepared.payload['datasets'] == ['general_qa']
    assert prepared.payload['dataset_args']['general_qa'] == {
        'local_path': str(runtime_config.input_dir / TASK_ID),
        'subset_list': ['databench'],
    }
    assert client.start(RUN_ID) is True
    manifests.mark_running(TASK_ID)
    terminal = manifests.record_terminal(TASK_ID, 'completed', metrics=[], provider_report_ids=[TASK_ID])
    assert client.callback(terminal, manifests.read_integration(TASK_ID) or {}) is True
    assert ('POST', f'/v2/evaluation-runs/{RUN_ID}:complete', {'metrics': [], 'provider_report_ids': [TASK_ID]}) in requests
    assert any(path.endswith(':finalize-result-upload') for _, path, _ in requests)


@pytest.mark.parametrize('first_put_result', ['expired', 'response_lost'])
def test_archive_refreshes_put_url_and_replays_lost_finalize_response(
    runtime_config,
    first_put_result: str,
) -> None:
    runtime_config.prepare()
    task_dir = runtime_config.output_dir / TASK_ID
    (task_dir / 'reports').mkdir(parents=True)
    (task_dir / 'reports' / 'summary.json').write_text('{"score":1}\n', encoding='utf-8')
    state = {'prepare': 0, 'put': 0, 'finalize': 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:prepare-result-upload':
            state['prepare'] += 1
            return httpx.Response(
                200,
                json=archive_prepare(
                    f'https://objects.example/staging/result.tar.zst?generation={state["prepare"]}'
                ),
            )
        if request.url.host == 'objects.example':
            assert 'authorization' not in request.headers
            assert request.headers['if-none-match'] == '*'
            state['put'] += 1
            if state['put'] == 1:
                if first_put_result == 'response_lost':
                    raise httpx.ReadError('PUT response lost', request=request)
                return httpx.Response(403)
            return httpx.Response(412 if first_put_result == 'response_lost' else 200)
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:finalize-result-upload':
            state['finalize'] += 1
            if state['finalize'] == 1:
                raise httpx.ReadError('finalize response lost', request=request)
            body = json.loads(request.content)
            return httpx.Response(200, json={
                'id': RUN_ID,
                'archive_status': 'available',
                'archive_attempt': 1,
                'result_artifact_digest': body['digest'],
                'result_artifact_size_bytes': body['size_bytes'],
            })
        raise AssertionError(f'unexpected request: {request.method} {request.url}')

    transport = httpx.MockTransport(handler)
    http = httpx.Client(base_url=runtime_config.databench_base_url, transport=transport)
    client = DatabenchClient(runtime_config, TaskManifestStore(runtime_config.output_dir), client=http, uploader=http)

    assert client._archive_completed_result(
        task_id=TASK_ID,
        run_id=RUN_ID,
        provider_report_ids=[TASK_ID],
    ) is True
    assert state == {'prepare': 2, 'put': 2, 'finalize': 2}


def test_permanent_archive_policy_failure_is_sanitized_and_marked_failed(runtime_config) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    manifests.claim(TASK_ID, 'evaluation', config_digest({'task': 1}, runtime_config.task_hmac_key))
    task_dir = runtime_config.output_dir / TASK_ID
    (task_dir / 'reports').mkdir()
    (task_dir / 'reports' / 'summary.json').write_text(
        '{"api_key":"must-not-leave-provider"}\n',
        encoding='utf-8',
    )
    terminal = manifests.record_terminal(
        TASK_ID,
        'completed',
        metrics=[],
        provider_report_ids=[TASK_ID],
    )
    failed_bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:complete':
            return httpx.Response(200, json={'id': RUN_ID, 'status': 'completed'})
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:prepare-result-upload':
            return httpx.Response(
                200,
                json=archive_prepare('https://objects.example/staging/result.tar.zst'),
            )
        if request.method == 'GET' and request.url.path == f'/v2/evaluation-runs/{RUN_ID}':
            return httpx.Response(200, json={'id': RUN_ID, 'archive_attempt': 1})
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:fail-result-upload':
            body = json.loads(request.content)
            failed_bodies.append(body)
            return httpx.Response(200, json={
                'id': RUN_ID,
                'archive_status': 'failed',
                'archive_attempt': 1,
            })
        raise AssertionError(f'unexpected request: {request.method} {request.url.path}')

    client = DatabenchClient(
        runtime_config,
        manifests,
        client=httpx.Client(
            base_url=runtime_config.databench_base_url,
            transport=httpx.MockTransport(handler),
        ),
    )
    integration = {'run_id': RUN_ID, 'task_id': TASK_ID}
    assert client.callback(terminal, integration) is True
    assert failed_bodies == [{
        'archive_attempt': 1,
        'error': {
            'phase': 'provider_archive',
            'code': 'archive_secret_detected',
            'message': 'EvalScope result archive was rejected by the archive policy',
        },
    }]
    assert 'must-not-leave-provider' not in json.dumps(failed_bodies)


def test_resolves_deployment_and_persists_only_v2_lineage(runtime_config) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    manifests.claim(TASK_ID, 'evaluation', config_digest({'task': 2}, runtime_config.task_hmac_key))
    deployment_id = '223e4567-e89b-42d3-a456-426614174000'
    artifact_id = '323e4567-e89b-42d3-a456-426614174000'
    deployment_digest = 'd' * 64
    requests: list[tuple[str, str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        requests.append((request.method, request.url.path, body))
        if request.url.path == f'/internal/v1/model-deployments/{deployment_id}:resolve':
            assert request.headers['authorization'] == f'Bearer {runtime_config.databench_service_credential}'
            return httpx.Response(200, json={
                'id': deployment_id,
                'artifact_id': artifact_id,
                'create_digest': deployment_digest,
                'provider': 'openai_compatible',
                'registration_mode': 'operator_attested',
                'served_model_name': 'deployed-lora-v1',
                'endpoint_base_url': 'http://127.0.0.1:8001/v1',
                'auth_mode': 'none',
                'base_model_reference': 'Qwen/Qwen3-0.6B',
                'base_model_revision': '0123456789abcdef',
            })
        if request.method == 'GET' and request.url.path == f'/v2/datasets/{VERSION}':
            return httpx.Response(200, json={
                'requested_ref': VERSION,
                'ref_name': None,
                'dataset_version': VERSION,
            })
        if request.url.path == f'/v2/datasets/{VERSION}:inspect-export':
            return httpx.Response(200, json={
                'dataset_version': VERSION,
                'converter': 'evalscope-general-qa',
                'converter_version': '1.0.0',
                'normalized_options': {'target_source': 'none'},
                'media_type': 'application/x-ndjson',
                'fidelity_digest': FIDELITY,
                'config_hints': {'evalscope': {'benchmark': 'general_qa', 'subset': 'databench'}},
            })
        if request.url.path == '/v2/evaluation-runs':
            return httpx.Response(201, json={
                'id': RUN_ID,
                'status': 'prepared',
                'model_name': 'deployed-lora-v1',
                'model_deployment_id': deployment_id,
                'model_artifact_id': artifact_id,
            })
        if request.url.path == f'/v2/datasets/{VERSION}:export':
            return httpx.Response(
                200,
                content=b'{"messages":[{"role":"user","content":"hi"}]}\n',
                headers={'content-type': 'application/x-ndjson'},
            )
        raise AssertionError(f'unexpected request: {request.method} {request.url.path}')

    http = httpx.Client(
        base_url=runtime_config.databench_base_url,
        headers={'Authorization': f'Bearer {runtime_config.databench_service_credential}'},
        transport=httpx.MockTransport(handler),
    )
    client = DatabenchClient(runtime_config, manifests, client=http)
    deployment = client.resolve_model_deployment(deployment_id)
    assert deployment == ResolvedModelDeployment(
        deployment_id=deployment_id,
        artifact_id=artifact_id,
        create_digest=deployment_digest,
        served_model_name='deployed-lora-v1',
        endpoint_base_url='http://127.0.0.1:8001/v1',
        base_model_reference='Qwen/Qwen3-0.6B',
        base_model_revision='0123456789abcdef',
    )
    prepared = client.prepare_evaluation(
        TASK_ID,
        {
            'databench_deployment_id': deployment_id,
            'databench_source': {},
            'api_url': deployment.endpoint_base_url,
            'model': deployment.served_model_name,
        },
        source(),
        deployment,
    )
    assert prepared.payload['model'] == 'deployed-lora-v1'
    assert prepared.payload['api_url'] == 'http://127.0.0.1:8001/v1'
    assert 'databench_deployment_id' not in prepared.payload
    integration = manifests.read_integration(TASK_ID)
    assert integration is not None
    assert integration['schema_version'] == 2
    assert integration['model_deployment_id'] == deployment_id
    assert integration['model_artifact_id'] == artifact_id
    assert integration['model_deployment_digest'] == deployment_digest
    serialized = json.dumps(integration)
    assert '127.0.0.1' not in serialized
    assert 'api_url' not in serialized
    assert (
        'POST',
        '/v2/evaluation-runs',
        {
            'provider': 'evalscope',
            'provider_task_id': TASK_ID,
            'dataset_version': VERSION,
            'source_ref': 'support-qa',
            'converter': 'evalscope-general-qa',
            'converter_options': {'target_source': 'none'},
            'accepted_fidelity_digest': FIDELITY,
            'model_name': None,
            'evalscope_commit': 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
            'model_deployment_id': deployment_id,
        },
    ) in requests


def test_fidelity_is_reinspected_and_mismatch_stops_before_create(runtime_config) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    manifests.claim(TASK_ID, 'evaluation', config_digest({'task': 1}, runtime_config.task_hmac_key))
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.method == 'GET':
            return httpx.Response(200, json={
                'requested_ref': VERSION,
                'ref_name': None,
                'dataset_version': VERSION,
            })
        return httpx.Response(200, json={
            'dataset_version': VERSION,
            'converter': 'evalscope-general-qa',
            'converter_version': '1.0.0',
            'normalized_options': {'target_source': 'none'},
            'media_type': 'application/x-ndjson',
            'fidelity_digest': 'c' * 64,
            'config_hints': {'evalscope': {'benchmark': 'general_qa', 'subset': 'databench'}},
        })

    client = DatabenchClient(
        runtime_config,
        manifests,
        client=httpx.Client(base_url=runtime_config.databench_base_url, transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(RuntimePolicyError) as captured:
        client.prepare_evaluation(TASK_ID, {'model': 'Qwen'}, source())
    assert captured.value.code == 'databench_fidelity_mismatch'
    assert '/v2/evaluation-runs' not in paths


@pytest.mark.parametrize(
    'change',
    [
        {'converter': 'canonical-jsonl'},
        {'dataset_version': '../dataset'},
        {'options': {'local_path': '/tmp/file'}},
        {'source_ref': 'https://evil.example/ref'},
    ],
)
def test_databench_source_envelope_is_strict(change: dict[str, Any]) -> None:
    value = {
        'source_ref': 'support-qa',
        'dataset_version': VERSION,
        'converter': 'evalscope-general-qa',
        'options': {'target_source': 'none'},
        'accepted_fidelity_digest': FIDELITY,
        **change,
    }
    with pytest.raises(RuntimePolicyError):
        DatabenchSource.parse(value)


def test_databench_redirect_is_never_followed(runtime_config) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    manifests.claim(TASK_ID, 'evaluation', config_digest({'task': 1}, runtime_config.task_hmac_key))
    client = DatabenchClient(
        runtime_config,
        manifests,
        client=httpx.Client(
            base_url=runtime_config.databench_base_url,
            transport=httpx.MockTransport(lambda _request: httpx.Response(302, headers={'location': 'http://evil.test'})),
            follow_redirects=False,
        ),
    )
    with pytest.raises(RuntimePolicyError) as captured:
        client.prepare_evaluation(TASK_ID, {'model': 'Qwen'}, source())
    assert captured.value.code == 'databench_redirect_rejected'


def test_terminal_callback_recovers_run_id_after_create_response_loss(runtime_config) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    manifests.claim(TASK_ID, 'evaluation', config_digest({'task': 1}, runtime_config.task_hmac_key))
    manifests.write_integration(TASK_ID, {
        'schema_version': 1,
        'task_id': TASK_ID,
        'run_id': None,
        'source_ref': 'support-qa',
        'dataset_version': VERSION,
        'converter': 'evalscope-general-qa',
        'options': {'target_source': 'none'},
        'accepted_fidelity_digest': FIDELITY,
        'model_name': 'Qwen',
        'evalscope_commit': 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
        'input_filename': 'databench.jsonl',
    })
    terminal = manifests.record_terminal(
        TASK_ID,
        'failed',
        error={'phase': 'provider_prepare', 'code': 'databench_unavailable', 'message': 'Unavailable'},
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == '/v2/evaluation-runs':
            return httpx.Response(201, json={'id': RUN_ID, 'status': 'prepared'})
        if request.url.path == f'/v2/evaluation-runs/{RUN_ID}:fail':
            return httpx.Response(200, json={'id': RUN_ID, 'status': 'failed'})
        raise AssertionError(f'unexpected request: {request.method} {request.url.path}')

    client = DatabenchClient(
        runtime_config,
        manifests,
        client=httpx.Client(base_url=runtime_config.databench_base_url, transport=httpx.MockTransport(handler)),
    )
    assert client.callback(terminal, manifests.read_integration(TASK_ID) or {}) is True
    assert manifests.read_integration(TASK_ID)['run_id'] == RUN_ID
