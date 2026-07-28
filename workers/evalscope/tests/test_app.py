from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

from databench_evalscope.app import create_app
from databench_evalscope.storage import TaskManifestStore, config_digest

EVAL_ID = 'eval_123e4567-e89b-42d3-a456-426614174000'
EVAL_ID_2 = 'eval_123e4567-e89b-42d3-a456-426614174001'
PERF_ID = 'perf_123e4567-e89b-42d3-a456-426614174002'


class FakeDatabench:
    def __init__(self) -> None:
        self.callbacks: list[str] = []

    def callback(self, manifest: dict[str, Any], _integration: dict[str, Any]) -> bool:
        self.callbacks.append(manifest['phase'])
        return True


def upstream_app(
    started: threading.Event | None = None,
    release: threading.Event | None = None,
    *,
    fail_eval: bool = False,
) -> Flask:
    app = Flask('upstream-test')

    @app.post('/api/v1/eval/invoke')
    def eval_invoke():
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
        return jsonify({
            'status': 'completed',
            'task_id': request.headers['EvalScope-Task-Id'],
            'result': {'authorization': 'Bearer secret', 'answer': 'ok'},
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
        return jsonify({'text': '/var/lib/evalscope/private authorization=secret', 'total_lines': 1})

    @app.get('/api/v1/eval/benchmarks')
    def benchmarks():
        return jsonify({'text': [], 'multimodal': [], 'agent': [], 'aigc': []})

    @app.get('/api/v1/reports/list')
    def reports_list():
        return jsonify({'reports': [], 'total': 0, 'page': 1, 'page_size': 20, 'filters': {}})

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
                '<div id="plot"></div><script src="https://evil.test/x"></script>'
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
