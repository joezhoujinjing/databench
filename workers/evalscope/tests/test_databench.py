from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from databench_evalscope.databench import (
    DatabenchClient,
    DatabenchSource,
    ResolvedModelDeployment,
)
from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.storage import TaskManifestStore, config_digest

TASK_ID = 'eval_123e4567-e89b-42d3-a456-426614174000'
RUN_ID = '123e4567-e89b-42d3-a456-426614174099'
VERSION = 'a' * 64
FIDELITY = 'b' * 64


def source() -> DatabenchSource:
    return DatabenchSource.parse({
        'source_ref': 'support-qa',
        'dataset_version': VERSION,
        'converter': 'evalscope-general-qa',
        'options': {'target_source': 'none'},
        'accepted_fidelity_digest': FIDELITY,
    })


def test_exact_inspect_create_export_start_and_complete(runtime_config) -> None:
    runtime_config.prepare()
    manifests = TaskManifestStore(runtime_config.output_dir)
    manifests.claim(TASK_ID, 'evaluation', config_digest({'task': 1}, runtime_config.task_hmac_key))
    requests: list[tuple[str, str, Any]] = []
    create_attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal create_attempts
        body = json.loads(request.content) if request.content else None
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
        raise AssertionError(f'unexpected request: {request.method} {request.url.path}')

    transport = httpx.MockTransport(handler)
    http = httpx.Client(base_url=runtime_config.databench_base_url, transport=transport)
    client = DatabenchClient(runtime_config, manifests, client=http)
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
