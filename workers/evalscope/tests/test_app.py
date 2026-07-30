from __future__ import annotations

import json
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request
import pytest

import databench_evalscope.app as app_module
from databench_evalscope.app import create_app
from databench_evalscope.databench import ResolvedModelDeployment
from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.storage import TaskManifestStore, config_digest

EVAL_ID = 'eval_123e4567-e89b-42d3-a456-426614174000'
EVAL_ID_2 = 'eval_123e4567-e89b-42d3-a456-426614174001'
PERF_ID = 'perf_123e4567-e89b-42d3-a456-426614174002'


class FakeDatabench:
    def __init__(self) -> None:
        self.callbacks: list[str] = []
        self.resolve_calls: list[str] = []

    def callback(self, manifest: dict[str, Any], _integration: dict[str, Any]) -> bool:
        self.callbacks.append(manifest['phase'])
        return True

    def resolve_model_deployment(self, deployment_id: str) -> ResolvedModelDeployment:
        self.resolve_calls.append(deployment_id)
        return ResolvedModelDeployment(
            deployment_id=deployment_id,
            artifact_id='223e4567-e89b-42d3-a456-426614174000',
            create_digest='d' * 64,
            served_model_name='deployed-lora-v1',
            endpoint_base_url='http://127.0.0.1:8001/v1',
            base_model_reference='Qwen/Qwen3-0.6B',
            base_model_revision='0123456789abcdef',
        )


def upstream_app(
    started: threading.Event | None = None,
    release: threading.Event | None = None,
    *,
    fail_eval: bool = False,
    received: list[dict[str, Any]] | None = None,
    deployment_report_task_id: str | None = None,
    evaluation_result: dict[str, Any] | None = None,
) -> Flask:
    app = Flask('upstream-test')

    @app.post('/api/v1/eval/invoke')
    def eval_invoke():
        submitted = request.get_json()
        if received is not None:
            received.append(submitted)
        if started is not None:
            started.set()
        if release is not None:
            assert release.wait(timeout=5)
        if fail_eval:
            return jsonify({
                'status': 'error',
                'task_id': request.headers['EvalScope-Task-Id'],
                'error': 'upstream failed',
            }), 500
        result: dict[str, Any] = evaluation_result or {
            'authorization': 'Bearer secret',
            'answer': 'ok',
        }
        if submitted.get('model') == 'deployed-lora-v1':
            result.update({
                'api_url': submitted.get('api_url'),
                'url': submitted.get('api_url'),
                'endpoint': submitted.get('api_url'),
                'api_key': 'not-configured',
                'note': f"connected to {submitted.get('api_url')}",
            })
        return jsonify({
            'status': 'completed',
            'task_id': request.headers['EvalScope-Task-Id'],
            'result': result,
            'table': 'ok',
        })

    @app.post('/api/v1/perf/invoke')
    def perf_invoke():
        return jsonify({'status': 'completed', 'task_id': PERF_ID, 'result': {}, 'table': 'ok'})

    @app.post('/api/v1/eval/stop')
    @app.post('/api/v1/perf/stop')
    def stop():
        return jsonify({'status': 'stopped'})

    @app.get('/api/v1/eval/progress')
    @app.get('/api/v1/perf/progress')
    def progress():
        return jsonify({'percent': 50})

    @app.get('/api/v1/eval/log')
    @app.get('/api/v1/perf/log')
    def log():
        return jsonify({
            'text': (
                '/var/lib/evalscope/private authorization=secret '
                'endpoint http://127.0.0.1:8001/v1'
            ),
            'total_lines': 1,
        })

    @app.get('/api/v1/eval/benchmarks')
    def benchmarks():
        return jsonify({'text': [], 'multimodal': [], 'agent': [], 'aigc': []})

    @app.get('/api/v1/reports/list')
    def reports_list():
        reports = [] if deployment_report_task_id is None else [{
            'name': f'{deployment_report_task_id}_model',
            'report_name': deployment_report_task_id,
            'task_config': {
                'api_url': 'http://127.0.0.1:8001/v1',
                'url': 'http://127.0.0.1:8001/v1',
                'endpoint': 'http://127.0.0.1:8001/v1',
                'api_key': 'not-configured',
                'note': 'endpoint is http://127.0.0.1:8001/v1',
            },
        }]
        return jsonify({
            'reports': reports,
            'total': len(reports),
            'page': 1,
            'page_size': 20,
            'filters': {},
        })

    @app.get('/api/v1/reports/load')
    def reports_load():
        return jsonify({
            'report_list': [],
            'datasets': ['general_qa'],
            'task_config': {},
        })

    @app.get('/api/v1/reports/predictions')
    def reports_predictions():
        return jsonify({
            'predictions': [],
            'total': 0,
            'page': request.args.get('page', 1, type=int),
            'page_size': request.args.get('page_size', 50, type=int),
            'counts': {'all': 0, 'above': 0, 'below': 0},
        })

    @app.get('/api/v1/perf/list')
    def perf_list():
        return jsonify({'runs': [], 'total': 0})

    @app.get('/api/v1/reports/analysis')
    def analysis():
        return jsonify({'analysis': '<p>safe</p><script>alert(1)</script>'})

    for path in (
        '/api/v1/eval/report',
        '/api/v1/perf/report',
        '/api/v1/perf/chart',
        '/api/v1/perf/compare/chart',
        '/api/v1/perf/history/report',
        '/api/v1/reports/html',
        '/api/v1/reports/chart',
    ):
        app.add_url_rule(
            path,
            f'doc_{path}',
            lambda: (
                '<div id="plot">endpoint http://127.0.0.1:8001/v1</div>'
                '<script src="https://evil.test/x"></script>'
                '<script>Plotly.newPlot("plot",[{"x":[1],"y":[2]}],{},{});alert(1)</script>',
                200,
                {'Content-Type': 'text/html'},
            ),
            methods=['GET'],
        )
    return app


def eval_payload(model: str = 'model') -> dict[str, Any]:
    return {
        'model': model,
        'datasets': ['general_qa'],
        'api_url': 'http://127.0.0.1:8001/v1',
    }


def test_backend_only_exact_route_and_config_boundary(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    assert client.get('/').status_code == 404
    assert client.get('/dashboard').status_code == 404
    assert client.post('/api/v1/eval/resume/invoke').status_code == 404
    assert client.get('/api/v1/reports/scan').status_code == 404
    assert client.get('/api/v1/synthetic-new-endpoint').status_code == 404
    assert client.get('/static/anything.js').status_code == 404
    assert client.head('/api/v1/config').status_code == 405
    assert client.options('/api/v1/eval/invoke').status_code == 405

    config = client.get('/api/v1/config').get_json()
    assert config == {
        'service_version': '0.1.0',
        'evalscope_commit': 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
        'capabilities': [
            'evaluation',
            'performance',
            'reports',
            'databench-dataset',
            'databench-model-deployment',
            'metric-selection',
            'generated-documents',
        ],
        'reports_configured': True,
        'report_root_generation': '0',
        'plotly_asset_sha256': '6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603',
    }
    assert '/var/' not in str(config)

    manifest_path = (
        Path(__file__).resolve().parents[3] / 'deploy' / 'evalscope' / 'api-routes.json'
    )
    route_manifest = json.loads(manifest_path.read_text())
    expected = {
        (
            route['method'],
            route['path'].replace(
                '{sha256}',
                '6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603',
            ).replace('{opaque_id}', '<opaque_id>'),
        )
        for route in route_manifest['routes']
        if route['classification'] in {'allowed', 'allowed-patched', 'databench-generated'}
    }
    expected.add(('POST', '/internal/v1/databench/tasks/<task_id>:reconcile'))
    expected.add(('POST', '/internal/v1/operator/drain'))
    expected.add(('POST', '/internal/v1/operator/resume'))
    expected.add(('GET', '/internal/v1/operator/status'))
    actual = {
        (method, rule.rule)
        for rule in app.url_map.iter_rules()
        for method in rule.methods
        if method not in {'HEAD', 'OPTIONS'}
    }
    assert actual == expected


def test_native_invoke_terminal_replay_mismatch_and_secret_sanitizing(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    first = client.post('/api/v1/eval/invoke', json=eval_payload(), headers={'EvalScope-Task-Id': EVAL_ID})
    assert first.status_code == 200
    body = first.get_json()
    assert body['terminal']['status'] == 'completed'
    assert 'authorization' not in body['result']

    replay = client.post('/api/v1/eval/invoke', json=eval_payload(), headers={'EvalScope-Task-Id': EVAL_ID})
    assert replay.status_code == 200
    assert replay.get_json()['status'] == 'terminal_replay'

    mismatch = client.post(
        '/api/v1/eval/invoke',
        json=eval_payload('different'),
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert mismatch.status_code == 409
    assert mismatch.get_json()['error']['code'] == 'task_id_conflict'
    manifest = app.extensions['databench_evalscope']['manifests'].read(EVAL_ID)
    assert manifest['phase'] == 'completed'


def test_completed_evaluation_normalizes_evalscope_metrics_for_databench(runtime_config) -> None:
    result = {
        'general_qa': {
            'dataset_name': 'general_qa',
            'metrics': [{
                'name': 'rouge-l',
                'score': 0.75,
                'num': 2,
                'categories': [{
                    'name': ['qa'],
                    'subsets': [{
                        'name': 'databench',
                        'score': 0.75,
                        'num': 2,
                        'is_aggregate': False,
                    }],
                }],
            }],
        },
    }
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(evaluation_result=result),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    response = app.test_client().post(
        '/api/v1/eval/invoke',
        json=eval_payload(),
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert response.status_code == 200
    manifest = app.extensions['databench_evalscope']['manifests'].read(EVAL_ID)
    assert manifest['terminal']['metrics'] == [{
        'dataset': 'general_qa',
        'subset': 'databench',
        'metric': 'rouge-l',
        'score': 0.75,
        'sample_count': 2,
        'categories': ['qa'],
    }]


def test_metric_catalogue_and_explicit_selection_compile_into_upstream_config(runtime_config) -> None:
    received: list[dict[str, Any]] = []
    result = {
        'general_qa': {
            'dataset_name': 'general_qa',
            'metrics': [{
                'name': 'mean_exact_match',
                'score': 1.0,
                'num': 1,
                'categories': [{
                    'name': ['qa'],
                    'subsets': [{
                        'name': 'default',
                        'score': 1.0,
                        'num': 1,
                        'is_aggregate': False,
                    }],
                }],
            }],
        },
    }
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(received=received, evaluation_result=result),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    catalogue = client.get('/api/v1/eval/metrics?benchmark=general_qa')
    assert catalogue.status_code == 200
    exact_match = next(
        metric for metric in catalogue.get_json()['metrics'] if metric['id'] == 'exact_match'
    )
    assert exact_match['availability']['selectable'] is True

    payload = eval_payload()
    payload['metric_selection'] = {
        'mode': 'explicit',
        'metric_ids': ['exact_match'],
        'primary_metric_id': 'exact_match',
        'parameters': {},
    }
    response = client.post(
        '/api/v1/eval/invoke',
        json=payload,
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert response.status_code == 200
    assert response.get_json()['terminal']['status'] == 'completed'
    assert response.get_json()['terminal']['metrics'][0] == {
        'categories': ['qa'],
        'dataset': 'general_qa',
        'metric': 'exact_match',
        'metric_id': 'exact_match',
        'output_key': 'exact_match',
        'sample_count': 1,
        'score': 1.0,
        'subset': 'default',
    }
    assert received[0]['dataset_args']['general_qa'] == {
        'metric_list': ['exact_match'],
        'metric_failure_is_fatal': True,
        'primary_metric_id': 'exact_match',
        'primary_output_key': 'mean_exact_match',
    }
    assert 'metric_selection' not in received[0]


def test_evaluation_rejects_more_than_one_benchmark(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    payload = eval_payload()
    payload['datasets'] = ['general_qa', 'gsm8k']
    response = app.test_client().post(
        '/api/v1/eval/invoke',
        json=payload,
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert response.status_code == 422
    assert response.get_json()['error']['code'] == 'single_benchmark_required'


def test_databench_evaluation_rejects_no_reference_scoring(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    response = app.test_client().post(
        '/api/v1/eval/invoke',
        json={
            'model': 'model',
            'api_url': 'http://127.0.0.1:8001/v1',
            'databench_source': {
                'source_ref': 'support-qa',
                'dataset_version': 'a' * 64,
                'converter': 'evalscope-general-qa',
                'options': {'target_source': 'none'},
                'accepted_fidelity_digest': 'b' * 64,
            },
        },
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert response.status_code == 422
    assert response.get_json()['error']['code'] == 'databench_target_source_unsupported'


def test_reports_expose_databench_source_identity_and_prediction_paging(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(deployment_report_task_id=EVAL_ID),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    manifests = app.extensions['databench_evalscope']['manifests']
    manifests.claim(EVAL_ID, 'evaluation', config_digest({'test': True}, runtime_config.task_hmac_key))
    manifests.write_integration(EVAL_ID, {
        'schema_version': 1,
        'task_id': EVAL_ID,
        'run_id': '123e4567-e89b-42d3-a456-426614174099',
        'source_ref': 'support-qa',
        'dataset_version': 'a' * 64,
        'converter': 'evalscope-general-qa',
        'options': {'target_source': 'selected-candidate'},
        'accepted_fidelity_digest': 'b' * 64,
        'model_name': 'model',
        'evalscope_commit': 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
        'input_filename': 'databench.jsonl',
    })
    client = app.test_client()
    reports = client.get('/api/v1/reports/list').get_json()
    assert reports['reports'][0]['databench_source'] == {
        'source_ref': 'support-qa',
        'dataset_version': 'a' * 64,
        'benchmark': 'general_qa',
    }
    loaded = client.get(f'/api/v1/reports/load?report_name={EVAL_ID}_model').get_json()
    assert loaded['databench_source'] == reports['reports'][0]['databench_source']
    predictions = client.get(
        f'/api/v1/reports/predictions?report_name={EVAL_ID}_model'
        '&dataset_name=general_qa&subset_name=databench'
        '&page=2&page_size=50&mode=below&threshold=0.5'
    )
    assert predictions.status_code == 200
    assert predictions.get_json()['page'] == 2
    assert client.get(
        f'/api/v1/reports/predictions?report_name={EVAL_ID}_model'
        '&dataset_name=general_qa&subset_name=databench'
        '&index=1&message_id_prefix=msg'
    ).status_code == 422


def test_deployment_mode_claims_opaque_payload_before_one_server_side_resolution(runtime_config) -> None:
    databench = FakeDatabench()
    received: list[dict[str, Any]] = []
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(
            received=received,
            deployment_report_task_id=EVAL_ID,
        ),
        databench_client=databench,
        reconcile_on_start=False,
    )
    client = app.test_client()
    deployment_id = '123e4567-e89b-42d3-a456-426614174099'
    opaque_payload = {
        'databench_deployment_id': deployment_id,
        'datasets': ['general_qa'],
    }
    first = client.post(
        '/api/v1/eval/invoke',
        json=opaque_payload,
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert first.status_code == 200
    first_text = json.dumps(first.get_json(), sort_keys=True)
    assert '127.0.0.1:8001' not in first_text
    assert 'api_url' not in first_text
    assert 'api_key' not in first_text
    assert '"endpoint"' not in first_text
    assert databench.resolve_calls == [deployment_id]
    assert received == [{
        'api_url': 'http://127.0.0.1:8001/v1',
        'datasets': ['general_qa'],
        'model': 'deployed-lora-v1',
    }]
    log = client.get(f'/api/v1/eval/log?task_id={EVAL_ID}').get_json()
    assert '127.0.0.1:8001' not in json.dumps(log)
    reports = client.get('/api/v1/reports/list').get_json()
    assert '127.0.0.1:8001' not in json.dumps(reports)
    assert 'api_url' not in json.dumps(reports)
    descriptor = client.get(f'/api/v1/eval/report?task_id={EVAL_ID}').get_json()
    document_url = descriptor['document_url'].removeprefix('/evalscope-api')
    document = client.get(document_url, headers={'Sec-Fetch-Dest': 'iframe'})
    assert '127.0.0.1:8001' not in document.get_data(as_text=True)

    replay = client.post(
        '/api/v1/eval/invoke',
        json=opaque_payload,
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert replay.status_code == 200
    assert replay.get_json()['status'] == 'terminal_replay'
    assert databench.resolve_calls == [deployment_id]

    mismatch = client.post(
        '/api/v1/eval/invoke',
        json={**opaque_payload, 'databench_deployment_id': '123e4567-e89b-42d3-a456-426614174098'},
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert mismatch.status_code == 409
    assert databench.resolve_calls == [deployment_id]


def test_terminal_replay_does_not_depend_on_current_disk_capacity(runtime_config, monkeypatch: pytest.MonkeyPatch) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    first = client.post(
        '/api/v1/eval/invoke',
        json=eval_payload(),
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert first.status_code == 200

    def exhausted(_runtime) -> None:
        raise RuntimePolicyError(
            'task_disk_capacity_exceeded',
            'EvalScope disk capacity is exhausted',
            503,
        )

    monkeypatch.setattr(app_module, '_assert_disk_capacity', exhausted)
    replay = client.post(
        '/api/v1/eval/invoke',
        json=eval_payload(),
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert replay.status_code == 200
    assert replay.get_json()['status'] == 'terminal_replay'


def test_deployment_mode_rejects_manual_model_fields_before_claim(runtime_config) -> None:
    databench = FakeDatabench()
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=databench,
        reconcile_on_start=False,
    )
    client = app.test_client()
    deployment_id = '123e4567-e89b-42d3-a456-426614174099'
    for field, value in (
        ('api_url', 'http://127.0.0.1:8001/v1'),
        ('api_key', ''),
        ('model', None),
    ):
        response = client.post(
            '/api/v1/eval/invoke',
            json={'databench_deployment_id': deployment_id, field: value},
            headers={'EvalScope-Task-Id': EVAL_ID},
        )
        assert response.status_code == 422
        assert response.get_json()['error']['code'] == 'model_source_conflict'
        assert not (runtime_config.output_dir / EVAL_ID).exists()
    assert databench.resolve_calls == []


def test_dataset_locator_and_model_endpoint_fail_before_claim(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    malicious = {**eval_payload(), 'dataset_args': {'nested': {'LOCAL-PATH': '/etc/passwd'}}}
    response = client.post(
        '/api/v1/eval/invoke',
        json=malicious,
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert response.status_code == 422
    assert response.get_json()['error']['code'] == 'dataset_args_locator_forbidden'
    assert not (runtime_config.output_dir / EVAL_ID).exists()

    endpoint = client.post(
        '/api/v1/eval/invoke',
        json={**eval_payload(), 'api_url': 'http://169.254.169.254/latest/meta-data'},
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert endpoint.status_code == 422
    assert not (runtime_config.output_dir / EVAL_ID).exists()


def test_reports_use_configured_root_and_safe_generated_documents(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    assert client.get('/api/v1/reports/list?root_path=/tmp').status_code == 422
    first = client.get('/api/v1/reports/list?refresh=true').get_json()
    second = client.get('/api/v1/reports/list').get_json()
    assert first['report_root_generation'] == second['report_root_generation']

    descriptor = client.get(f'/api/v1/eval/report?task_id={EVAL_ID}').get_json()
    document_url = descriptor['document_url'].removeprefix('/evalscope-api')
    assert client.get(document_url).status_code == 403
    document = client.get(document_url, headers={'Sec-Fetch-Dest': 'iframe'})
    assert document.status_code == 200
    text = document.get_data(as_text=True)
    assert 'evil.test' not in text
    assert 'alert(1)' not in text
    assert 'Plotly.newPlot' in text
    assert "connect-src 'none'" in document.headers['Content-Security-Policy']
    asset = client.get(
        '/generated-assets/plotly-6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603.min.js'
    )
    assert asset.status_code == 200
    assert asset.headers['Cross-Origin-Resource-Policy'] == 'cross-origin'

    analysis = client.get('/api/v1/reports/analysis?report_name=run/model&dataset_name=qa').get_json()
    assert '<script>' not in analysis['analysis']


def test_blocking_invoke_and_polling_are_concurrent(runtime_config) -> None:
    started = threading.Event()
    release = threading.Event()
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(started, release),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    result: list[int] = []

    def invoke() -> None:
        with app.test_client() as client:
            response = client.post(
                '/api/v1/eval/invoke',
                json=eval_payload(),
                headers={'EvalScope-Task-Id': EVAL_ID_2},
            )
            result.append(response.status_code)

    thread = threading.Thread(target=invoke)
    thread.start()
    assert started.wait(timeout=2)
    with app.test_client() as client:
        progress = client.get(f'/api/v1/eval/progress?task_id={EVAL_ID_2}')
        assert progress.status_code == 200
        assert progress.get_json()['percent'] == 50
    release.set()
    thread.join(timeout=5)
    assert result == [200]


def test_operator_drain_blocks_new_tasks_while_polling_and_active_task_complete(runtime_config) -> None:
    started = threading.Event()
    release = threading.Event()
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(started, release),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    operator_headers = {'Authorization': f'Bearer {runtime_config.operator_token.decode()}'}
    result: list[int] = []

    def invoke() -> None:
        with app.test_client() as client:
            response = client.post(
                '/api/v1/eval/invoke',
                json=eval_payload(),
                headers={'EvalScope-Task-Id': EVAL_ID_2},
            )
            result.append(response.status_code)

    thread = threading.Thread(target=invoke)
    thread.start()
    assert started.wait(timeout=2)
    with app.test_client() as client:
        assert client.post('/internal/v1/operator/drain').status_code == 401
        assert client.post(
            '/internal/v1/operator/drain',
            data=b'{}',
            headers=operator_headers,
        ).status_code == 400
        drained = client.post('/internal/v1/operator/drain', headers=operator_headers)
        assert drained.get_json() == {'active_tasks': 1, 'draining': True, 'ready': False}
        rejected = client.post(
            '/api/v1/eval/invoke',
            json=eval_payload(),
            headers={'EvalScope-Task-Id': EVAL_ID},
        )
        assert rejected.status_code == 503
        assert rejected.get_json()['error']['code'] == 'runtime_draining'
        progress = client.get(f'/api/v1/eval/progress?task_id={EVAL_ID_2}')
        assert progress.status_code == 200
        status = client.get('/internal/v1/operator/status', headers=operator_headers)
        assert status.get_json()['active_tasks'] == 1
        assert client.get(
            '/internal/v1/operator/status',
            data=b'{}',
            headers=operator_headers,
        ).status_code == 400
    release.set()
    thread.join(timeout=5)
    assert result == [200]
    with app.test_client() as client:
        status = client.get('/internal/v1/operator/status', headers=operator_headers)
        assert status.get_json() == {'active_tasks': 0, 'draining': True, 'ready': False}
        resumed = client.post('/internal/v1/operator/resume', headers=operator_headers)
        assert resumed.get_json() == {'active_tasks': 0, 'draining': False, 'ready': True}


def test_capacity_admission_rejects_unbounded_eval_and_performance_before_claim(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    evaluation = client.post(
        '/api/v1/eval/invoke',
        json={**eval_payload(), 'limit': runtime_config.evaluation_sample_limit_max + 1},
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert evaluation.status_code == 422
    assert evaluation.get_json()['error'] == {
        'code': 'task_capacity_invalid',
        'field': '/limit',
        'message': 'limit exceeds its configured bound',
    }
    evaluation_batch = client.post(
        '/api/v1/eval/invoke',
        json={**eval_payload(), 'eval_batch_size': runtime_config.evaluation_batch_size_max + 1},
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert evaluation_batch.status_code == 422
    assert evaluation_batch.get_json()['error']['field'] == '/eval_batch_size'
    performance = client.post(
        '/api/v1/perf/invoke',
        json={
            'model': 'model',
            'url': 'http://127.0.0.1:8001/v1',
            'parallel': [1],
            'number': [runtime_config.performance_requests_max + 1],
        },
        headers={'EvalScope-Task-Id': PERF_ID},
    )
    assert performance.status_code == 422
    assert performance.get_json()['error']['field'] == '/number'
    performance_rate = client.post(
        '/api/v1/perf/invoke',
        json={
            'model': 'model',
            'url': 'http://127.0.0.1:8001/v1',
            'parallel': [1],
            'number': [1],
            'rate': runtime_config.performance_rate_max + 1,
        },
        headers={'EvalScope-Task-Id': PERF_ID},
    )
    assert performance_rate.status_code == 422
    assert performance_rate.get_json()['error']['field'] == '/rate'
    assert not (runtime_config.output_dir / EVAL_ID).exists()
    assert not (runtime_config.output_dir / PERF_ID).exists()


def test_task_runtime_limit_stops_and_records_stable_terminal(runtime_config) -> None:
    slow = Flask('slow-upstream')

    @slow.post('/api/v1/eval/invoke')
    def slow_invoke():
        time.sleep(0.1)
        return jsonify({
            'status': 'completed',
            'task_id': request.headers['EvalScope-Task-Id'],
        })

    bounded = replace(runtime_config, task_runtime_seconds=0.02)
    app = create_app(
        bounded,
        upstream_app=slow,
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    response = app.test_client().post(
        '/api/v1/eval/invoke',
        json=eval_payload(),
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert response.status_code == 200
    assert response.get_json()['terminal']['error'] == {
        'phase': 'provider_run',
        'code': 'task_runtime_exceeded',
        'message': 'EvalScope task exceeded its configured runtime',
    }


def test_progress_replays_persisted_terminal_after_invoke(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    invoked = client.post(
        '/api/v1/eval/invoke',
        json=eval_payload(),
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert invoked.status_code == 200

    progress = client.get(f'/api/v1/eval/progress?task_id={EVAL_ID}')
    assert progress.status_code == 200
    assert progress.get_json() == {
        'percent': 100,
        'current_step': 'completed',
        'terminal': invoked.get_json()['terminal'],
    }


def test_claimed_provider_failure_returns_and_replays_typed_terminal(runtime_config) -> None:
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(fail_eval=True),
        databench_client=FakeDatabench(),
        reconcile_on_start=False,
    )
    client = app.test_client()
    invoked = client.post(
        '/api/v1/eval/invoke',
        json=eval_payload(),
        headers={'EvalScope-Task-Id': EVAL_ID},
    )
    assert invoked.status_code == 200
    assert invoked.get_json() == {
        'status': 'error',
        'task_id': EVAL_ID,
        'error': 'upstream failed',
        'terminal': {
            'status': 'failed',
            'metrics': None,
            'provider_report_ids': None,
            'error': {
                'phase': 'provider_run',
                'code': 'provider_failed',
                'message': 'EvalScope task failed',
            },
        },
    }
    progress = client.get(f'/api/v1/eval/progress?task_id={EVAL_ID}')
    assert progress.status_code == 200
    assert progress.get_json()['terminal'] == invoked.get_json()['terminal']


def test_manual_and_startup_reconciliation(runtime_config) -> None:
    runtime_config.prepare()
    store = TaskManifestStore(runtime_config.output_dir)
    store.claim(EVAL_ID, 'evaluation', config_digest({'task': 1}, runtime_config.task_hmac_key))
    databench = FakeDatabench()
    app = create_app(
        runtime_config,
        upstream_app=upstream_app(),
        databench_client=databench,
        reconcile_on_start=True,
    )
    reconciliation = app.extensions['databench_evalscope']['startup_reconciliation']
    assert reconciliation.interrupted == 1
    assert app.extensions['databench_evalscope']['manifests'].read(EVAL_ID)['phase'] == 'failed'

    client = app.test_client()
    assert client.post(f'/internal/v1/databench/tasks/{EVAL_ID}:reconcile').status_code == 401
    authorized = client.post(
        f'/internal/v1/databench/tasks/{EVAL_ID}:reconcile',
        headers={'Authorization': f'Bearer {runtime_config.operator_token.decode()}'},
    )
    assert authorized.status_code == 200
    assert authorized.get_json()['phase'] == 'failed'
