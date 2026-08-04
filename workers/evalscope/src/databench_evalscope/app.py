"""Backend-only Flask boundary for the pinned EvalScope application."""

from __future__ import annotations

import copy
import hmac
import json
import math
import os
import re
import threading
from pathlib import Path
from typing import Any, Mapping

from flask import Flask, Response, jsonify, request, send_file
from werkzeug.test import Client as WsgiClient
from werkzeug.wrappers import Response as WerkzeugResponse

from .config import EVALSCOPE_COMMIT, RuntimeConfig
from .databench import DatabenchClient, DatabenchSource
from .documents import (
    GeneratedDocumentStore,
    resolve_media,
    sanitize_active_html,
    sanitize_deployment_json,
    sanitize_deployment_text,
    sanitize_json,
    sanitize_text,
)
from .errors import RuntimePolicyError, UpstreamProtocolError
from .metrics import MetricCatalogue, ResolvedMetricSelection
from .model_credentials import (
    AnonymousCredentialFdHandoffV1,
    ModelCredentialRegistryV1,
    ModelCredentialSnapshotV1,
)
from .model_endpoint_policy import ModelEndpointPolicyV1, load_model_endpoint_policy_v1
from .security import validate_dataset_args, validate_task_id
from .storage import TaskManifestStore, config_digest

_PLOTLY_ASSET_ROUTE = '/generated-assets/plotly-6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603.min.js'
_SAFE_RELATIVE = re.compile(r'^[^\x00-\x1f\x7f\\]{1,2048}$')
_MODEL_DEPLOYMENT_ID = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)
_DEPLOYMENT_TASK_ID_IN_TEXT = re.compile(
    r'eval_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
)
_DOCUMENT_KINDS = {
    '/api/v1/eval/report': 'evaluation-report',
    '/api/v1/perf/report': 'performance-report',
    '/api/v1/perf/chart': 'performance-chart',
    '/api/v1/perf/compare/chart': 'performance-compare-chart',
    '/api/v1/perf/history/report': 'performance-history-report',
    '/api/v1/reports/html': 'evaluation-report',
    '/api/v1/reports/chart': 'evaluation-chart',
}
_QUERY_FIELDS: dict[str, frozenset[str]] = {
    '/api/v1/eval/stop': frozenset({'task_id'}),
    '/api/v1/eval/progress': frozenset({'task_id'}),
    '/api/v1/eval/log': frozenset({'task_id', 'start_line', 'page'}),
    '/api/v1/eval/report': frozenset({'task_id'}),
    '/api/v1/eval/benchmarks': frozenset({'type', 'all'}),
    '/api/v1/eval/metrics': frozenset({'benchmark'}),
    '/api/v1/perf/stop': frozenset({'task_id'}),
    '/api/v1/perf/progress': frozenset({'task_id'}),
    '/api/v1/perf/log': frozenset({'task_id', 'start_line', 'page'}),
    '/api/v1/perf/report': frozenset({'task_id'}),
    '/api/v1/perf/list': frozenset({'refresh'}),
    '/api/v1/perf/detail': frozenset({'path'}),
    '/api/v1/perf/chart': frozenset({'path', 'chart_type', 'run', 'theme'}),
    '/api/v1/perf/compare/chart': frozenset({'paths', 'chart_type', 'theme'}),
    '/api/v1/perf/runs': frozenset({'path'}),
    '/api/v1/perf/requests': frozenset({'path', 'run', 'status', 'page', 'page_size'}),
    '/api/v1/perf/history/report': frozenset({'path'}),
    '/api/v1/reports/list': frozenset({
        'search', 'models', 'datasets', 'score_min', 'score_max', 'sort_by', 'sort_order',
        'page', 'page_size', 'refresh',
    }),
    '/api/v1/reports/load': frozenset({'report_name'}),
    '/api/v1/reports/load_multi': frozenset({'report_names'}),
    '/api/v1/reports/dataframe': frozenset({'report_name', 'type', 'dataset_name'}),
    '/api/v1/reports/predictions': frozenset({
        'report_name',
        'dataset_name',
        'subset_name',
        'page',
        'page_size',
        'mode',
        'threshold',
        'index',
        'message_id_prefix',
    }),
    '/api/v1/reports/analysis': frozenset({'report_name', 'dataset_name'}),
    '/api/v1/reports/html': frozenset({'report_name'}),
    '/api/v1/reports/chart': frozenset({
        'report_name', 'report_names', 'chart_type', 'dataset_name', 'subset_name', 'theme',
    }),
    '/api/v1/reports/media/file': frozenset({'path'}),
}
_JSON_PROXY_ROUTES = frozenset(set(_QUERY_FIELDS) - set(_DOCUMENT_KINDS) - {
    '/api/v1/eval/stop',
    '/api/v1/eval/metrics',
    '/api/v1/perf/stop',
    '/api/v1/reports/media/file',
})
_POST_ROUTES = frozenset({
    '/api/v1/eval/invoke',
    '/api/v1/eval/stop',
    '/api/v1/perf/invoke',
    '/api/v1/perf/stop',
})
_GET_ROUTES = frozenset({
    '/health',
    '/api/v1/config',
    '/api/v1/eval/metrics',
    '/api/v1/reports/media/file',
    _PLOTLY_ASSET_ROUTE,
    *_JSON_PROXY_ROUTES,
    *_DOCUMENT_KINDS,
})


class RuntimeAdmission:
    """Process-local drain fence for the single-worker Gunicorn runtime."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._draining = False
        self._active_tasks = 0

    def begin_task(self) -> None:
        with self._lock:
            if self._draining:
                raise RuntimePolicyError(
                    'runtime_draining',
                    'EvalScope is draining and does not accept new tasks',
                    503,
                )
            self._active_tasks += 1

    def finish_task(self) -> None:
        with self._lock:
            if self._active_tasks <= 0:
                raise RuntimeError('EvalScope active task accounting underflow')
            self._active_tasks -= 1

    def drain(self) -> dict[str, int | bool]:
        with self._lock:
            self._draining = True
            return self._snapshot_unlocked()

    def resume(self) -> dict[str, int | bool]:
        with self._lock:
            self._draining = False
            return self._snapshot_unlocked()

    def snapshot(self) -> dict[str, int | bool]:
        with self._lock:
            return self._snapshot_unlocked()

    def _snapshot_unlocked(self) -> dict[str, int | bool]:
        return {
            'draining': self._draining,
            'active_tasks': self._active_tasks,
            'ready': not self._draining,
        }


def create_app(
    config: RuntimeConfig | None = None,
    *,
    upstream_app: Flask | None = None,
    databench_client: DatabenchClient | None = None,
    reconcile_on_start: bool = True,
) -> Flask:
    runtime = RuntimeConfig.from_env() if config is None else config
    runtime.prepare()
    manifests = TaskManifestStore(runtime.output_dir, max_tasks=runtime.max_tasks)
    documents = GeneratedDocumentStore(
        runtime.output_dir,
        ttl_seconds=runtime.document_ttl_seconds,
        max_bytes=runtime.document_max_bytes,
        plotly_digest=runtime.plotly_asset_sha256,
        databench_origin=runtime.databench_origin,
    )
    endpoint_policy = ModelEndpointPolicyV1(
        load_model_endpoint_policy_v1(runtime.model_endpoint_policy_path),
        release_profile='offline',
    )
    metric_catalogue = MetricCatalogue.load()
    model_credentials = None
    if runtime.model_credentials_path is not None:
        model_credentials = ModelCredentialRegistryV1(
            runtime.model_credentials_path,
            'evalscope',
        )
        model_credentials.reload()
    upstream = _load_upstream(runtime) if upstream_app is None else upstream_app
    databench = databench_client or DatabenchClient(runtime, manifests)
    app = Flask(__name__, static_folder=None)
    app.json.ensure_ascii = False
    app.config['MAX_CONTENT_LENGTH'] = runtime.request_max_bytes
    app.extensions['databench_evalscope'] = {
        'config': runtime,
        'manifests': manifests,
        'documents': documents,
        'databench': databench,
        'metric_catalogue': metric_catalogue,
        'model_credentials': model_credentials,
        'upstream': upstream,
    }
    evaluation_slots = threading.BoundedSemaphore(runtime.max_concurrent_evals)
    performance_slots = threading.BoundedSemaphore(runtime.max_concurrent_perf)
    admission = RuntimeAdmission()
    app.extensions['databench_evalscope']['admission'] = admission
    generation_lock = threading.Lock()
    deployment_endpoint_lock = threading.Lock()
    deployment_endpoints: dict[str, str] = {}
    report_generation = 0

    if reconcile_on_start:
        reconciliation = manifests.reconcile_all(databench.callback)
    else:
        reconciliation = None
    app.extensions['databench_evalscope']['startup_reconciliation'] = reconciliation

    @app.before_request
    def exact_method_boundary():
        expected = _expected_method(request.path)
        if expected is not None and request.method != expected:
            raise RuntimePolicyError('method_not_allowed', 'Method is not allowed for this endpoint', 405)

    @app.after_request
    def private_response(response: Response):
        response.headers.setdefault('Cache-Control', 'private, no-store')
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('Referrer-Policy', 'no-referrer')
        response.headers.pop('Access-Control-Allow-Origin', None)
        response.headers.pop('Set-Cookie', None)
        return response

    @app.errorhandler(RuntimePolicyError)
    def policy_error(error: RuntimePolicyError):
        return jsonify(error.to_body()), error.status

    @app.errorhandler(413)
    def request_too_large(_: Any):
        error = RuntimePolicyError('request_too_large', 'Request exceeds the configured byte bound', 413)
        return jsonify(error.to_body()), error.status

    @app.errorhandler(404)
    def not_found(_: Any):
        error = RuntimePolicyError('not_found', 'Endpoint not found', 404)
        return jsonify(error.to_body()), error.status

    @app.errorhandler(405)
    def method_not_allowed(_: Any):
        error = RuntimePolicyError('method_not_allowed', 'Method is not allowed for this endpoint', 405)
        return jsonify(error.to_body()), error.status

    @app.errorhandler(Exception)
    def internal_error(_: Exception):
        error = RuntimePolicyError('internal_error', 'Internal EvalScope integration error', 500)
        return jsonify(error.to_body()), error.status

    @app.get('/health')
    def health():
        _reject_query('/health', frozenset())
        return jsonify({
            'status': 'ok',
            'service': 'evalscope-backend',
            'ready': True,
            'evalscope_commit': EVALSCOPE_COMMIT,
        })

    @app.get('/api/v1/config')
    def capability_config():
        _reject_query('/api/v1/config', frozenset())
        return jsonify({
            'service_version': '0.1.0',
            'evalscope_commit': EVALSCOPE_COMMIT,
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
            'report_root_generation': str(report_generation),
            'plotly_asset_sha256': runtime.plotly_asset_sha256,
        })

    @app.post('/api/v1/eval/invoke')
    def eval_invoke():
        return _invoke(
            'evaluation',
            evaluation_slots,
            admission,
            runtime,
            manifests,
            databench,
            endpoint_policy,
            model_credentials,
            upstream,
            deployment_endpoints,
            deployment_endpoint_lock,
            metric_catalogue,
        )

    @app.post('/api/v1/perf/invoke')
    def perf_invoke():
        return _invoke(
            'performance',
            performance_slots,
            admission,
            runtime,
            manifests,
            databench,
            endpoint_policy,
            model_credentials,
            upstream,
            deployment_endpoints,
            deployment_endpoint_lock,
            metric_catalogue,
        )

    @app.get('/api/v1/eval/metrics')
    def eval_metrics():
        query = _validated_query('/api/v1/eval/metrics')
        benchmark = query.get('benchmark')
        if benchmark is None:
            raise RuntimePolicyError(
                'query_field_required',
                'benchmark is required',
                422,
                '/query/benchmark',
            )
        return jsonify(metric_catalogue.response(benchmark))

    def stop(kind: str):
        path = f'/api/v1/{"eval" if kind == "evaluation" else "perf"}/stop'
        query = _validated_query(path)
        task_id = validate_task_id(query['task_id'])
        if (kind == 'evaluation') != task_id.startswith('eval_'):
            raise RuntimePolicyError('invalid_task_id', 'Task ID prefix does not match task kind', 400)
        manifest = manifests.request_stop(task_id)
        if manifest['phase'] in {'completed', 'failed', 'cancelled'}:
            return jsonify({'status': 'terminal_replay', 'task_id': task_id, 'terminal': manifest['terminal']})
        response = _dispatch_upstream(upstream, 'POST', path, query={'task_id': task_id})
        return jsonify({
            'status': 'stop_requested',
            'task_id': task_id,
            'provider_signal': 'sent' if response.status_code < 300 else 'pending',
        }), 202

    app.add_url_rule('/api/v1/eval/stop', 'eval_stop', lambda: stop('evaluation'), methods=['POST'])
    app.add_url_rule('/api/v1/perf/stop', 'perf_stop', lambda: stop('performance'), methods=['POST'])

    for path in sorted(_JSON_PROXY_ROUTES):
        def json_proxy(route_path: str = path):
            nonlocal report_generation
            query = _validated_query(route_path)
            refresh = query.pop('refresh', None)
            if route_path in {'/api/v1/eval/progress', '/api/v1/perf/progress'}:
                task_id = validate_task_id(query['task_id'])
                try:
                    manifest = manifests.read(task_id)
                except RuntimePolicyError as error:
                    if error.code != 'task_not_found':
                        raise
                else:
                    if manifest['terminal'] is not None:
                        return jsonify({
                            'percent': 100 if manifest['phase'] == 'completed' else 0,
                            'current_step': manifest['phase'],
                            'terminal': manifest['terminal'],
                        })
            response = _dispatch_upstream(upstream, 'GET', route_path, query=query)
            payload, status = _bounded_json_response(response, runtime.response_max_bytes)
            safe = _sanitize_browser_json(
                payload,
                manifests,
                deployment_endpoints,
                deployment_endpoint_lock,
                runtime.allowed_media_roots,
                tuple(query.values()),
            )
            if isinstance(safe, dict):
                _enrich_databench_report_source(safe, route_path, query, manifests)
            if route_path == '/api/v1/reports/analysis' and isinstance(safe, dict):
                analysis = safe.get('analysis')
                if isinstance(analysis, str):
                    safe['analysis'] = sanitize_active_html(analysis)
            if route_path in {'/api/v1/reports/list', '/api/v1/perf/list'} and isinstance(safe, dict):
                with generation_lock:
                    if refresh == 'true' or report_generation == 0:
                        report_generation += 1
                    safe['report_root_generation'] = str(report_generation)
            return jsonify(safe), status

        app.add_url_rule(path, f'proxy_{path.replace("/", "_")}', json_proxy, methods=['GET'])

    for path, kind in _DOCUMENT_KINDS.items():
        def document_proxy(route_path: str = path, document_kind: str = kind):
            query = _validated_query(route_path)
            response = _dispatch_upstream(upstream, 'GET', route_path, query=query)
            if response.status_code >= 300:
                payload, status = _bounded_json_response(response, runtime.response_max_bytes)
                return jsonify(_sanitize_browser_json(
                    payload,
                    manifests,
                    deployment_endpoints,
                    deployment_endpoint_lock,
                    runtime.allowed_media_roots,
                    tuple(query.values()),
                )), status
            raw = response.get_data()
            if len(raw) > runtime.document_max_bytes:
                raise RuntimePolicyError('generated_document_too_large', 'Generated document exceeds its bound', 413)
            media_type = response.headers.get('Content-Type', '').split(';', 1)[0].lower()
            if media_type != 'text/html':
                raise UpstreamProtocolError('EvalScope report did not return HTML')
            try:
                html_source = raw.decode('utf-8')
            except UnicodeDecodeError as exc:
                raise UpstreamProtocolError('EvalScope report is not valid UTF-8') from exc
            endpoint_values, redact_unmatched_urls = _deployment_redaction_context(
                manifests,
                deployment_endpoints,
                deployment_endpoint_lock,
                tuple(query.values()),
            )
            if endpoint_values or redact_unmatched_urls:
                html_source = sanitize_deployment_text(
                    html_source,
                    endpoint_values=endpoint_values,
                    redact_unmatched_urls=redact_unmatched_urls,
                )
            return jsonify(documents.create(html_source, kind=document_kind).to_dict())

        app.add_url_rule(path, f'document_{path.replace("/", "_")}', document_proxy, methods=['GET'])

    @app.get('/api/v1/reports/media/file')
    def media_file():
        query = _validated_query('/api/v1/reports/media/file')
        path, media_type = resolve_media(runtime.allowed_media_roots, query['path'])
        response = send_file(path, mimetype=media_type, conditional=True, etag=True, max_age=0)
        response.headers['Content-Disposition'] = 'inline'
        return response

    @app.get('/generated-documents/<opaque_id>')
    def generated_document(opaque_id: str):
        _reject_query(request.path, frozenset())
        if request.headers.get('Sec-Fetch-Dest') != 'iframe':
            raise RuntimePolicyError(
                'generated_document_context_rejected',
                'Generated documents may only be loaded by the Databench sandbox viewer',
                403,
            )
        body, headers = documents.read(opaque_id)
        return Response(body, 200, headers)

    @app.get(_PLOTLY_ASSET_ROUTE)
    def plotly_asset():
        _reject_query(request.path, frozenset())
        response = send_file(runtime.plotly_asset_path, mimetype='application/javascript', conditional=True, etag=True)
        response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        # A document sandboxed without allow-same-origin has an opaque origin.
        # This public, digest-pinned asset must therefore permit that frame to
        # load it while every non-pinned asset URL remains unroutable.
        response.headers['Cross-Origin-Resource-Policy'] = 'cross-origin'
        return response

    @app.post('/internal/v1/databench/tasks/<task_id>:reconcile')
    def manual_reconcile(task_id: str):
        _require_operator(runtime)
        _reject_query(request.path, frozenset())
        _reject_request_body()
        manifest = manifests.reconcile_one(task_id, databench.callback)
        app.logger.info('operator reconciliation completed for task %s', task_id)
        return jsonify({'task_id': task_id, 'phase': manifest['phase'], 'callback_confirmed': manifest['callback_confirmed']})

    @app.post('/internal/v1/operator/drain')
    def operator_drain():
        _require_operator(runtime)
        _reject_query(request.path, frozenset())
        _reject_request_body()
        return jsonify(admission.drain())

    @app.post('/internal/v1/operator/resume')
    def operator_resume():
        _require_operator(runtime)
        _reject_query(request.path, frozenset())
        _reject_request_body()
        return jsonify(admission.resume())

    @app.get('/internal/v1/operator/status')
    def operator_status():
        _require_operator(runtime)
        _reject_query(request.path, frozenset())
        _reject_request_body()
        return jsonify(admission.snapshot())

    return app


def _expected_method(path: str) -> str | None:
    if (
        path in _POST_ROUTES
        or path in {'/internal/v1/operator/drain', '/internal/v1/operator/resume'}
        or re.fullmatch(r'/internal/v1/databench/tasks/[^/]+:reconcile', path)
    ):
        return 'POST'
    if (
        path in _GET_ROUTES
        or path == '/internal/v1/operator/status'
        or re.fullmatch(r'/generated-documents/[A-Za-z0-9_-]+', path)
    ):
        return 'GET'
    return None


def _invoke(
    kind: str,
    slots: threading.BoundedSemaphore,
    admission: RuntimeAdmission,
    runtime: RuntimeConfig,
    manifests: TaskManifestStore,
    databench: DatabenchClient,
    endpoint_policy: ModelEndpointPolicyV1,
    model_credentials: ModelCredentialRegistryV1 | None,
    upstream: Flask,
    deployment_endpoints: dict[str, str],
    deployment_endpoint_lock: threading.Lock,
    metric_catalogue: MetricCatalogue,
):
    path = '/api/v1/eval/invoke' if kind == 'evaluation' else '/api/v1/perf/invoke'
    _reject_query(path, frozenset())
    payload = _json_body(runtime.request_max_bytes)
    task_id = validate_task_id(request.headers.get('EvalScope-Task-Id', ''))
    if (kind == 'evaluation') != task_id.startswith('eval_'):
        raise RuntimePolicyError('invalid_task_id', 'Task ID prefix does not match task kind', 400)
    source = DatabenchSource.parse(payload['databench_source']) if 'databench_source' in payload else None
    if source is not None and source.options['target_source'] == 'none':
        raise RuntimePolicyError(
            'databench_target_source_unsupported',
            'A reference answer is required until judge-based scoring is available',
            422,
            '/databench_source/options/target_source',
        )
    dataset_args = payload.get('dataset_args', {})
    validate_dataset_args(dataset_args)
    if source is not None and 'dataset_args' in payload:
        raise RuntimePolicyError(
            'databench_source_invalid',
            'Databench source tasks cannot also submit dataset_args',
            422,
            '/dataset_args',
        )
    deployment_id = _model_deployment_id(payload, kind)
    if kind == 'performance':
        if 'metric_selection' in payload:
            raise RuntimePolicyError(
                'metric_selection_unsupported',
                'Metric selection is only supported for evaluation tasks',
                422,
                '/metric_selection',
            )
        execution_payload = copy.deepcopy(payload)
        metric_selection = None
    else:
        benchmark = _evaluation_benchmark(payload, source)
        execution_payload, metric_selection = metric_catalogue.apply(
            payload,
            benchmark,
            enforce_availability=False,
        )
    endpoint_field = 'api_url' if kind == 'evaluation' else 'url'
    endpoint = payload.get(endpoint_field)
    if deployment_id is None:
        if not isinstance(endpoint, str):
            raise RuntimePolicyError(
                'model_endpoint_url_rejected',
                'Model endpoint URL is required',
                422,
                f'/{endpoint_field}',
            )
    digest = config_digest(
        {
            'task_kind': kind,
            'payload': execution_payload,
            'scoring_config': None if metric_selection is None else metric_selection.scoring_config,
        },
        runtime.task_hmac_key,
    )
    claim = manifests.claim(task_id, kind, digest)
    if claim.disposition == 'already_running':
        return jsonify({
            'error': {'code': 'already_running', 'message': 'Task is already active'},
            'task_id': task_id,
        }), 409
    if claim.disposition == 'terminal_replay':
        integration = manifests.read_integration(task_id)
        if integration is not None and not claim.manifest['callback_confirmed']:
            if databench.callback(claim.manifest, integration):
                manifests.confirm_callback(task_id)
        return jsonify({
            'status': 'terminal_replay',
            'task_id': task_id,
            'terminal': claim.manifest['terminal'],
        })

    admitted = False
    slot_acquired = False
    failure_phase = 'task_capacity'
    try:
        if kind == 'evaluation':
            execution_payload, admitted_metric_selection = metric_catalogue.apply(
                payload,
                benchmark,
                enforce_availability=True,
            )
            if (
                metric_selection is not None
                and admitted_metric_selection is not None
                and admitted_metric_selection.scoring_config != metric_selection.scoring_config
            ):
                raise RuntimePolicyError(
                    'metric_registry_changed',
                    'Metric registry changed during task admission',
                    503,
                )
            metric_selection = admitted_metric_selection

        capacity_payload = execution_payload
        if kind == 'evaluation' and source is not None and 'datasets' not in execution_payload:
            capacity_payload = {**execution_payload, 'datasets': ['general_qa']}
        _validate_task_capacity(
            kind,
            capacity_payload,
            runtime,
            opaque_model=deployment_id is not None,
        )
        _assert_disk_capacity(runtime)
        if not slots.acquire(blocking=False):
            raise RuntimePolicyError(
                'task_concurrency_exceeded',
                'EvalScope task concurrency is exhausted',
                503,
            )
        slot_acquired = True
        admission.begin_task()
        admitted = True

        deployment = None
        credential_snapshot = None
        if deployment_id is not None:
            failure_phase = 'model_resolve'
            deployment = databench.resolve_model_version_deployment(deployment_id)
            if 'chat_completions' not in deployment.declared_capabilities.interfaces:
                raise RuntimePolicyError(
                    'model_capability_mismatch',
                    'Model Deployment does not declare chat completions capability',
                    409,
                )

        failure_phase = 'endpoint_policy'
        if deployment is None:
            endpoint_policy.authorize_connection(endpoint)
        else:
            endpoint_policy.authorize_connection(deployment.endpoint_base_url)

        failure_phase = 'credential_resolve'
        if deployment is not None and deployment.auth_profile == 'bearer_ref':
            if model_credentials is None or deployment.credential_ref is None:
                raise RuntimePolicyError(
                    'credential_registry_not_loaded',
                    'Model credential operation failed',
                    503,
                )
            credential_snapshot = model_credentials.resolve(
                deployment.credential_ref,
                deployment.deployment_id,
            )

        if deployment is not None:
            with deployment_endpoint_lock:
                deployment_endpoints[task_id] = deployment.endpoint_base_url
            execution_payload.pop('databench_deployment_id', None)
            execution_payload['api_url'] = deployment.endpoint_base_url
            execution_payload['model'] = deployment.served_model_name

        failure_phase = 'provider_prepare'
        if source is not None:
            prepared = databench.prepare_evaluation(
                task_id,
                execution_payload,
                source,
                deployment,
                None if metric_selection is None else metric_selection.scoring_config,
            )
            execution_payload = prepared.payload
        _cancel_if_requested(manifests, task_id)
        manifests.mark_running(task_id)
        if source is not None:
            integration = manifests.read_integration(task_id)
            if integration is None or not isinstance(integration.get('run_id'), str) or not databench.start(integration['run_id']):
                raise RuntimePolicyError('databench_callback_unavailable', 'Databench run could not start', 503)
        _cancel_if_requested(manifests, task_id)
        failure_phase = 'provider_run'
        response = _dispatch_task_upstream(
            upstream,
            path,
            task_id,
            runtime.task_runtime_seconds,
            body=execution_payload,
            headers={'EvalScope-Task-Id': task_id},
            credential_snapshot=credential_snapshot,
        )
        payload_response, status = _bounded_json_response(response, runtime.response_max_bytes)
        if payload_response.get('task_id') != task_id:
            raise UpstreamProtocolError('EvalScope returned a mismatched task identifier')
        if status < 300 and payload_response.get('status') == 'completed':
            metrics = _extract_evaluation_metrics(payload_response) if kind == 'evaluation' else []
            if metric_selection is not None:
                metrics = metric_catalogue.bind_outputs(metric_selection, metrics)
                metric_catalogue.assert_outputs(metric_selection, metrics)
            manifest = manifests.record_terminal(
                task_id,
                'completed',
                metrics=metrics,
                provider_report_ids=[task_id] if kind == 'evaluation' else [],
            )
        else:
            manifest = manifests.record_terminal(
                task_id,
                'failed',
                error={
                    'phase': 'provider_run',
                    'code': 'provider_failed',
                    'message': 'EvalScope task failed',
                },
            )
        _confirm_callback(manifests, databench, task_id, manifest)
        safe = _sanitize_browser_json(
            payload_response,
            manifests,
            deployment_endpoints,
            deployment_endpoint_lock,
            runtime.allowed_media_roots,
            (task_id,),
        )
        safe['terminal'] = manifest['terminal']
        return jsonify(safe), 200
    except RuntimePolicyError as error:
        try:
            current = manifests.read(task_id)
        except RuntimePolicyError:
            raise error
        if current['phase'] not in {'completed', 'failed', 'cancelled'}:
            phase = (
                'metric'
                if error.code == 'metric_execution_failed'
                else 'provider_run' if current['phase'] == 'running' else failure_phase
            )
            manifest = manifests.record_terminal(
                task_id,
                'failed',
                error={
                    'phase': phase,
                    'code': _safe_error_code(error.code),
                    'message': sanitize_text(error.message)[:2048],
                },
            )
            _confirm_callback(manifests, databench, task_id, manifest)
        else:
            manifest = current
            _confirm_callback(manifests, databench, task_id, current)
        terminal = manifest['terminal']
        return jsonify({
            'status': 'stopped' if manifest['phase'] == 'cancelled' else 'error',
            'task_id': task_id,
            'error': terminal['error']['message'],
            'terminal': terminal,
        }), 200
    except Exception as exc:
        try:
            manifest = manifests.record_terminal(
                task_id,
                'failed',
                error={
                    'phase': failure_phase,
                    'code': 'provider_failed',
                    'message': 'EvalScope task failed',
                },
            )
            _confirm_callback(manifests, databench, task_id, manifest)
        except Exception:
            raise RuntimePolicyError('provider_failed', 'EvalScope task failed', 500) from exc
        return jsonify({
            'status': 'error',
            'task_id': task_id,
            'error': manifest['terminal']['error']['message'],
            'terminal': manifest['terminal'],
        }), 200
    finally:
        if admitted:
            admission.finish_task()
        if slot_acquired:
            slots.release()


def _evaluation_benchmark(
    payload: dict[str, Any],
    source: DatabenchSource | None,
) -> str:
    datasets = payload.get('datasets')
    if source is not None:
        if datasets is not None:
            raise RuntimePolicyError(
                'databench_source_invalid',
                'Databench source tasks derive their Benchmark from the converter',
                422,
                '/datasets',
            )
        return 'general_qa'
    if (
        not isinstance(datasets, list)
        or len(datasets) != 1
        or not isinstance(datasets[0], str)
        or not datasets[0].strip()
        or len(datasets[0].encode('utf-8')) > 256
    ):
        raise RuntimePolicyError(
            'single_benchmark_required',
            'Evaluation tasks require exactly one Benchmark',
            422,
            '/datasets',
        )
    return datasets[0]


def _model_deployment_id(payload: dict[str, Any], kind: str) -> str | None:
    if 'databench_deployment_id' not in payload:
        return None
    if kind != 'evaluation':
        raise RuntimePolicyError(
            'model_deployment_unsupported',
            'Databench Model Deployments are only supported for evaluation tasks',
            422,
            '/databench_deployment_id',
        )
    deployment_id = payload.get('databench_deployment_id')
    if not isinstance(deployment_id, str) or not _MODEL_DEPLOYMENT_ID.fullmatch(deployment_id):
        raise RuntimePolicyError(
            'model_deployment_invalid',
            'Databench Model Deployment ID is invalid',
            422,
            '/databench_deployment_id',
        )
    conflicting = next(
        (field for field in ('api_url', 'api_key', 'model') if field in payload),
        None,
    )
    if conflicting is not None:
        raise RuntimePolicyError(
            'model_source_conflict',
            'Databench Deployment mode cannot include api_url, api_key, or model',
            422,
            f'/{conflicting}',
        )
    return deployment_id


def _sanitize_browser_json(
    value: Any,
    manifests: TaskManifestStore,
    deployment_endpoints: dict[str, str],
    deployment_endpoint_lock: threading.Lock,
    media_roots: tuple[Path, ...],
    context_strings: tuple[str, ...] = (),
) -> Any:
    safe = sanitize_json(value, media_roots=media_roots)
    endpoint_values, redact_unmatched_urls = _deployment_redaction_context(
        manifests,
        deployment_endpoints,
        deployment_endpoint_lock,
        context_strings,
    )
    if endpoint_values or redact_unmatched_urls:
        return sanitize_deployment_json(
            safe,
            endpoint_values=endpoint_values,
            redact_unmatched_urls=redact_unmatched_urls,
        )
    return _sanitize_detected_deployment_branches(
        safe,
        manifests,
        deployment_endpoints,
        deployment_endpoint_lock,
    )


def _sanitize_detected_deployment_branches(
    value: Any,
    manifests: TaskManifestStore,
    deployment_endpoints: dict[str, str],
    deployment_endpoint_lock: threading.Lock,
) -> Any:
    if isinstance(value, list):
        return [
            _sanitize_detected_deployment_branches(
                item,
                manifests,
                deployment_endpoints,
                deployment_endpoint_lock,
            )
            for item in value
        ]
    if not isinstance(value, dict):
        return value
    scalar_context = tuple(
        str(item)
        for item in (*value.keys(), *value.values())
        if isinstance(item, str)
    )
    endpoint_values, redact_unmatched_urls = _deployment_redaction_context(
        manifests,
        deployment_endpoints,
        deployment_endpoint_lock,
        scalar_context,
    )
    if endpoint_values or redact_unmatched_urls:
        return sanitize_deployment_json(
            value,
            endpoint_values=endpoint_values,
            redact_unmatched_urls=redact_unmatched_urls,
        )
    return {
        key: _sanitize_detected_deployment_branches(
            child,
            manifests,
            deployment_endpoints,
            deployment_endpoint_lock,
        )
        for key, child in value.items()
    }


def _deployment_redaction_context(
    manifests: TaskManifestStore,
    deployment_endpoints: dict[str, str],
    deployment_endpoint_lock: threading.Lock,
    values: tuple[str, ...],
) -> tuple[tuple[str, ...], bool]:
    task_ids = {
        task_id
        for value in values
        for task_id in _DEPLOYMENT_TASK_ID_IN_TEXT.findall(value)
    }
    endpoints: set[str] = set()
    redact_unmatched_urls = False
    for task_id in task_ids:
        with deployment_endpoint_lock:
            endpoint = deployment_endpoints.get(task_id)
        if endpoint is not None:
            endpoints.add(endpoint)
            continue
        try:
            integration = manifests.read_integration(task_id)
        except RuntimePolicyError:
            continue
        if integration is not None and integration.get('schema_version') == 2:
            redact_unmatched_urls = True
    return tuple(sorted(endpoints)), redact_unmatched_urls


def _cancel_if_requested(manifests: TaskManifestStore, task_id: str) -> None:
    manifest = manifests.read(task_id)
    if manifest['stop_requested_at'] is None:
        return
    cancelled = manifests.record_terminal(task_id, 'cancelled')
    raise RuntimePolicyError('task_cancelled', cancelled['terminal']['error']['message'], 409)


def _confirm_callback(
    manifests: TaskManifestStore,
    databench: DatabenchClient,
    task_id: str,
    manifest: dict[str, Any],
) -> None:
    integration = manifests.read_integration(task_id)
    if integration is not None and databench.callback(manifest, integration):
        manifests.confirm_callback(task_id)


def _require_operator(runtime: RuntimeConfig) -> None:
    expected = b'Bearer ' + runtime.operator_token
    provided = request.headers.get('Authorization', '').encode('utf-8')
    if not hmac.compare_digest(expected, provided):
        raise RuntimePolicyError('operator_auth_required', 'Operator authentication is required', 401)


def _reject_request_body() -> None:
    if request.content_length not in {None, 0} or request.get_data(cache=False):
        raise RuntimePolicyError(
            'unexpected_request_body',
            'This operator endpoint does not accept a request body',
            400,
        )


def _validate_task_capacity(
    kind: str,
    payload: dict[str, Any],
    runtime: RuntimeConfig,
    *,
    opaque_model: bool = False,
) -> None:
    model = payload.get('model')
    if not opaque_model and (
        not isinstance(model, str) or not model.strip() or len(model.encode('utf-8')) > 512
    ):
        raise RuntimePolicyError(
            'task_capacity_invalid',
            'Model identifier is missing or exceeds its byte limit',
            422,
            '/model',
        )
    datasets = payload.get('datasets')
    if kind == 'evaluation':
        if (
            not isinstance(datasets, list)
            or len(datasets) != 1
            or any(
                not isinstance(item, str)
                or not item.strip()
                or len(item.encode('utf-8')) > 256
                for item in datasets
            )
        ):
            raise RuntimePolicyError(
                'single_benchmark_required',
                'Evaluation tasks require exactly one Benchmark',
                422,
                '/datasets',
            )
    if kind == 'evaluation':
        _optional_bounded_integer(
            payload,
            'limit',
            1,
            runtime.evaluation_sample_limit_max,
            '/limit',
        )
        _optional_bounded_integer(
            payload,
            'eval_batch_size',
            1,
            runtime.evaluation_batch_size_max,
            '/eval_batch_size',
        )
        _optional_bounded_integer(
            payload,
            'repeats',
            1,
            runtime.evaluation_repeats_max,
            '/repeats',
        )
        _optional_bounded_number(
            payload,
            'timeout',
            0,
            runtime.request_timeout_seconds_max,
            '/timeout',
        )
        generation = payload.get('generation_config')
        if generation is not None and not isinstance(generation, dict):
            raise RuntimePolicyError(
                'task_capacity_invalid',
                'Generation config must be an object',
                422,
                '/generation_config',
            )
        if isinstance(generation, dict):
            _optional_bounded_integer(
                generation,
                'max_tokens',
                1,
                runtime.model_tokens_max,
                '/generation_config/max_tokens',
            )
            _optional_bounded_integer(
                generation,
                'top_k',
                1,
                runtime.model_tokens_max,
                '/generation_config/top_k',
            )
            _optional_bounded_number(
                generation,
                'top_p',
                0,
                1,
                '/generation_config/top_p',
            )
            _optional_bounded_number(
                generation,
                'temperature',
                0,
                2,
                '/generation_config/temperature',
            )
        return

    parallel = _positive_integer_list(
        payload.get('parallel'),
        runtime.performance_parallel_max,
        '/parallel',
    )
    requests = _positive_integer_list(
        payload.get('number'),
        runtime.performance_requests_max,
        '/number',
    )
    if sum(requests) > runtime.performance_requests_max:
        raise RuntimePolicyError(
            'task_capacity_invalid',
            'Total performance requests exceed the configured bound',
            422,
            '/number',
        )
    if max(parallel) > runtime.performance_parallel_max:
        raise RuntimePolicyError(
            'task_capacity_invalid',
            'Performance parallelism exceeds the configured bound',
            422,
            '/parallel',
        )
    _optional_bounded_integer(payload, 'max_tokens', 1, runtime.model_tokens_max, '/max_tokens')
    _optional_bounded_integer(
        payload,
        'max_prompt_length',
        0,
        runtime.model_tokens_max,
        '/max_prompt_length',
    )
    for field in ('min_tokens', 'min_prompt_length'):
        _optional_bounded_integer(payload, field, 0, runtime.model_tokens_max, f'/{field}')
    _optional_bounded_number(
        payload,
        'rate',
        0,
        runtime.performance_rate_max,
        '/rate',
    )
    _validate_minimum_maximum(payload, 'min_tokens', 'max_tokens')
    _validate_minimum_maximum(payload, 'min_prompt_length', 'max_prompt_length')


def _positive_integer_list(value: Any, maximum: int, field: str) -> list[int]:
    values = value if isinstance(value, list) else [value]
    if not values or len(values) > 16:
        raise RuntimePolicyError(
            'task_capacity_invalid',
            'Performance sweep exceeds its configured bound',
            422,
            field,
        )
    if any(
        isinstance(item, bool)
        or not isinstance(item, int)
        or item <= 0
        or item > maximum
        for item in values
    ):
        raise RuntimePolicyError(
            'task_capacity_invalid',
            'Performance sweep contains an out-of-range value',
            422,
            field,
        )
    return values


def _optional_bounded_integer(
    value: Mapping[str, Any],
    key: str,
    minimum: int,
    maximum: int,
    field: str,
) -> None:
    if key not in value or value[key] is None:
        return
    candidate = value[key]
    if (
        isinstance(candidate, bool)
        or not isinstance(candidate, int)
        or candidate < minimum
        or candidate > maximum
    ):
        raise RuntimePolicyError(
            'task_capacity_invalid',
            f'{key} exceeds its configured bound',
            422,
            field,
        )


def _optional_bounded_number(
    value: Mapping[str, Any],
    key: str,
    minimum: float,
    maximum: float,
    field: str,
) -> None:
    if key not in value or value[key] is None:
        return
    candidate = value[key]
    valid_number = (
        not isinstance(candidate, bool)
        and isinstance(candidate, (int, float))
        and (not isinstance(candidate, float) or math.isfinite(candidate))
    )
    below_minimum = candidate < minimum if valid_number else True
    if not valid_number or below_minimum or candidate > maximum:
        raise RuntimePolicyError(
            'task_capacity_invalid',
            f'{key} exceeds its configured bound',
            422,
            field,
        )


def _validate_minimum_maximum(value: Mapping[str, Any], minimum_key: str, maximum_key: str) -> None:
    minimum = value.get(minimum_key)
    maximum = value.get(maximum_key)
    if isinstance(minimum, int) and isinstance(maximum, int) and minimum > maximum:
        raise RuntimePolicyError(
            'task_capacity_invalid',
            f'{minimum_key} cannot exceed {maximum_key}',
            422,
            f'/{minimum_key}',
        )


def _load_upstream(runtime: RuntimeConfig) -> Flask:
    os.environ['EVALSCOPE_OUTPUT_DIR'] = str(runtime.output_dir)
    os.environ['EVALSCOPE_SERVE_WEB'] = 'false'
    os.environ['EVALSCOPE_TASK_MODEL_ENDPOINT_POLICY'] = (
        '' if runtime.model_endpoint_policy_path is None else str(runtime.model_endpoint_policy_path)
    )
    from evalscope.service.app import create_app as create_upstream_app

    return create_upstream_app(outputs=str(runtime.output_dir))


def _dispatch_task_upstream(
    app: Flask,
    path: str,
    task_id: str,
    timeout_seconds: int,
    *,
    body: dict[str, Any],
    headers: Mapping[str, str],
    credential_snapshot: ModelCredentialSnapshotV1 | None = None,
) -> WerkzeugResponse:
    timed_out = threading.Event()

    def terminate_task() -> None:
        timed_out.set()
        try:
            from evalscope.service.utils.process import stop_process

            stop_process(task_id)
        except Exception:
            # The stable terminal envelope is recorded by the caller. Never
            # expose an upstream process-registry failure to the response.
            return

    timer = threading.Timer(timeout_seconds, terminate_task)
    timer.daemon = True
    timer.start()
    try:
        if credential_snapshot is None:
            response = _dispatch_upstream(
                app,
                'POST',
                path,
                body=body,
                headers=headers,
            )
        else:
            with AnonymousCredentialFdHandoffV1(credential_snapshot) as handoff:
                response = _dispatch_upstream(
                    app,
                    'POST',
                    path,
                    body=body,
                    headers={
                        **headers,
                        'Databench-Credential-Fd': str(handoff.read_fd),
                    },
                )
    finally:
        timer.cancel()
    if timed_out.is_set():
        raise RuntimePolicyError(
            'task_runtime_exceeded',
            'EvalScope task exceeded its configured runtime',
            503,
        )
    return response


def _dispatch_upstream(
    app: Flask,
    method: str,
    path: str,
    *,
    query: Mapping[str, str] | None = None,
    body: dict[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> WerkzeugResponse:
    client = WsgiClient(app, WerkzeugResponse)
    data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    safe_headers = dict(headers or {})
    if body is not None:
        safe_headers['Content-Type'] = 'application/json'
    return client.open(
        path=path,
        method=method,
        query_string=dict(query or {}),
        data=data,
        headers=safe_headers,
        buffered=True,
    )


def _json_body(max_bytes: int) -> dict[str, Any]:
    media_type = request.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
    if media_type != 'application/json':
        raise RuntimePolicyError('unsupported_media_type', 'Content-Type must be application/json', 415)
    raw = request.get_data(cache=False)
    if not raw or len(raw) > max_bytes:
        raise RuntimePolicyError('request_too_large', 'Request body is empty or too large', 413)
    try:
        value = json.loads(raw, parse_constant=lambda _: _reject_non_finite())
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise RuntimePolicyError('invalid_json', 'Request body must be valid JSON', 400) from exc
    if not isinstance(value, dict):
        raise RuntimePolicyError('invalid_json', 'Request body must be a JSON object', 400)
    _validate_json_complexity(value)
    return value


def _reject_non_finite() -> None:
    raise ValueError('non-finite JSON number')


def _validate_json_complexity(value: Any) -> None:
    nodes = 0

    def visit(node: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > 100_000 or depth > 64:
            raise RuntimePolicyError('request_too_complex', 'Request JSON exceeds its complexity bound', 413)
        if isinstance(node, dict):
            for key, child in node.items():
                if not isinstance(key, str) or len(key.encode('utf-8')) > 1024:
                    raise RuntimePolicyError('invalid_json', 'Request JSON key is invalid', 400)
                visit(child, depth + 1)
        elif isinstance(node, list):
            for child in node:
                visit(child, depth + 1)
        elif isinstance(node, float) and not math.isfinite(node):
            raise RuntimePolicyError('invalid_json', 'Request JSON contains a non-finite number', 400)

    visit(value, 0)


def _bounded_json_response(response: WerkzeugResponse, max_bytes: int) -> tuple[dict[str, Any], int]:
    raw = response.get_data()
    if len(raw) > max_bytes:
        raise UpstreamProtocolError('EvalScope response exceeds its configured bound')
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpstreamProtocolError() from exc
    if not isinstance(value, dict):
        raise UpstreamProtocolError()
    return value, response.status_code


def _validated_query(path: str) -> dict[str, str]:
    allowed = _QUERY_FIELDS[path]
    result = _reject_query(path, allowed)
    _validate_query_values(path, result)
    return result


def _reject_query(path: str, allowed: frozenset[str]) -> dict[str, str]:
    if len(request.query_string) > 8192:
        raise RuntimePolicyError('query_too_large', 'Query string exceeds its byte bound', 413)
    unknown = set(request.args) - allowed
    if unknown:
        raise RuntimePolicyError('query_field_forbidden', 'Request contains an unreviewed query field', 422)
    result: dict[str, str] = {}
    for key in request.args:
        values = request.args.getlist(key)
        if len(values) != 1:
            raise RuntimePolicyError('query_field_invalid', 'Duplicate query fields are not allowed', 422, f'/query/{key}')
        result[key] = values[0]
    return result


def _validate_query_values(path: str, query: dict[str, str]) -> None:
    required: dict[str, set[str]] = {
        '/api/v1/perf/detail': {'path'},
        '/api/v1/perf/chart': {'path'},
        '/api/v1/perf/compare/chart': {'paths'},
        '/api/v1/perf/runs': {'path'},
        '/api/v1/perf/requests': {'path', 'run'},
        '/api/v1/perf/history/report': {'path'},
        '/api/v1/reports/load': {'report_name'},
        '/api/v1/reports/load_multi': {'report_names'},
        '/api/v1/reports/dataframe': {'report_name'},
        '/api/v1/reports/predictions': {'report_name', 'dataset_name', 'subset_name'},
        '/api/v1/reports/analysis': {'report_name', 'dataset_name'},
        '/api/v1/reports/html': {'report_name'},
        '/api/v1/reports/media/file': {'path'},
    }
    missing = required.get(path, set()) - set(query)
    if missing:
        field = sorted(missing)[0]
        raise RuntimePolicyError('query_field_required', f'{field} is required', 422, f'/query/{field}')
    task_query_routes = {
        '/api/v1/eval/stop', '/api/v1/eval/progress', '/api/v1/eval/log', '/api/v1/eval/report',
        '/api/v1/perf/stop', '/api/v1/perf/progress', '/api/v1/perf/log', '/api/v1/perf/report',
    }
    if path in task_query_routes:
        if 'task_id' not in query:
            raise RuntimePolicyError('query_field_required', 'task_id is required', 422, '/query/task_id')
        validate_task_id(query['task_id'])
        if path.startswith('/api/v1/eval/') != query['task_id'].startswith('eval_'):
            raise RuntimePolicyError('invalid_task_id', 'Task ID prefix does not match endpoint', 400)
    for key in ('start_line', 'page', 'page_size'):
        if key in query:
            maximum = 100_000_000 if key == 'start_line' else 500 if key == 'page_size' else 1_000_000
            _bounded_integer(query[key], key, 0 if key == 'start_line' else 1, maximum)
    for key in ('score_min', 'score_max'):
        if key in query:
            try:
                value = float(query[key])
            except ValueError as exc:
                raise RuntimePolicyError('query_field_invalid', f'{key} must be a number', 422, f'/query/{key}') from exc
            if not math.isfinite(value) or value < 0 or value > 1:
                raise RuntimePolicyError('query_field_invalid', f'{key} must be between 0 and 1', 422, f'/query/{key}')
    if 'threshold' in query:
        try:
            threshold = float(query['threshold'])
        except ValueError as exc:
            raise RuntimePolicyError(
                'query_field_invalid',
                'threshold must be a number',
                422,
                '/query/threshold',
            ) from exc
        if not math.isfinite(threshold) or threshold < 0 or threshold > 1:
            raise RuntimePolicyError(
                'query_field_invalid',
                'threshold must be between 0 and 1',
                422,
                '/query/threshold',
            )
    if query.get('mode', 'all') not in {'all', 'above', 'below'}:
        raise RuntimePolicyError(
            'query_field_invalid',
            'mode is invalid',
            422,
            '/query/mode',
        )
    if 'index' in query and 'message_id_prefix' in query:
        raise RuntimePolicyError(
            'query_field_invalid',
            'Only one prediction locator may be submitted',
            422,
            '/query/index',
        )
    for key in ('index', 'message_id_prefix'):
        if key in query and (
            not query[key].strip()
            or len(query[key].encode('utf-8')) > 512
            or _has_control(query[key])
        ):
            raise RuntimePolicyError(
                'query_field_invalid',
                f'{key} is invalid',
                422,
                f'/query/{key}',
            )
    for key in ('path', 'run', 'report_name'):
        if key in query:
            _validate_relative(query[key], key)
    for key in ('paths', 'report_names'):
        if key in query:
            parts = [part.strip() for part in query[key].split(';') if part.strip()]
            if not parts or len(parts) > 16:
                raise RuntimePolicyError('query_field_invalid', f'{key} is invalid', 422, f'/query/{key}')
            for part in parts:
                _validate_relative(part, key)
    for key in ('search', 'models', 'datasets', 'dataset_name', 'subset_name'):
        if key in query and (not query[key] or len(query[key].encode('utf-8')) > 4096 or _has_control(query[key])):
            raise RuntimePolicyError('query_field_invalid', f'{key} is invalid', 422, f'/query/{key}')
    enums: dict[str, set[str]] = {
        'all': {'true', 'false'},
        'refresh': {'true', 'false'},
        'theme': {'dark', 'light'},
        'sort_by': {'score', 'model', 'dataset', 'time'},
        'sort_order': {'asc', 'desc'},
        'status': {'success', 'failed'},
    }
    for key, choices in enums.items():
        if key in query and query[key] not in choices:
            raise RuntimePolicyError('query_field_invalid', f'{key} is invalid', 422, f'/query/{key}')
    if path == '/api/v1/eval/benchmarks' and query.get('type', '') not in {'', 'text', 'multimodal', 'agent', 'aigc'}:
        raise RuntimePolicyError('query_field_invalid', 'type is invalid', 422, '/query/type')
    if path == '/api/v1/reports/dataframe' and query.get('type', 'acc') not in {'acc', 'compare', 'dataset'}:
        raise RuntimePolicyError('query_field_invalid', 'type is invalid', 422, '/query/type')
    if path == '/api/v1/reports/dataframe' and query.get('type') == 'dataset' and 'dataset_name' not in query:
        raise RuntimePolicyError('query_field_required', 'dataset_name is required', 422, '/query/dataset_name')
    sweep_charts = {'latency', 'ttft', 'tpot', 'rps', 'throughput', 'success'}
    per_run_charts = {
        'percentile_latency', 'percentile_token', 'req_latency', 'req_ttft_tpot',
        'req_tokens', 'req_success',
    }
    if path == '/api/v1/perf/chart':
        chart_type = query.get('chart_type', 'latency')
        if chart_type not in sweep_charts | per_run_charts:
            raise RuntimePolicyError('query_field_invalid', 'chart_type is invalid', 422, '/query/chart_type')
        if chart_type in per_run_charts and 'run' not in query:
            raise RuntimePolicyError('query_field_required', 'run is required', 422, '/query/run')
    if path == '/api/v1/perf/compare/chart' and query.get('chart_type', 'rps') not in sweep_charts:
        raise RuntimePolicyError('query_field_invalid', 'chart_type is invalid', 422, '/query/chart_type')
    if path == '/api/v1/reports/chart':
        chart_type = query.get('chart_type', 'scores')
        if chart_type not in {'scores', 'sunburst', 'dataset_scores', 'radar', 'histogram', 'grouped_bar'}:
            raise RuntimePolicyError('query_field_invalid', 'chart_type is invalid', 422, '/query/chart_type')
        if chart_type == 'grouped_bar' and 'report_names' not in query:
            raise RuntimePolicyError('query_field_required', 'report_names is required', 422, '/query/report_names')
        if chart_type == 'radar' and not ({'report_name', 'report_names'} & set(query)):
            raise RuntimePolicyError(
                'query_field_required',
                'report_name or report_names is required',
                422,
                '/query/report_names',
            )
        if chart_type == 'histogram' and not {'report_name', 'dataset_name', 'subset_name'} <= set(query):
            raise RuntimePolicyError(
                'query_field_required',
                'report_name, dataset_name, and subset_name are required',
                422,
                '/query/report_name',
            )
        if chart_type not in {'radar', 'grouped_bar', 'histogram'} and 'report_name' not in query:
            raise RuntimePolicyError('query_field_required', 'report_name is required', 422, '/query/report_name')
        if chart_type == 'dataset_scores' and 'dataset_name' not in query:
            raise RuntimePolicyError('query_field_required', 'dataset_name is required', 422, '/query/dataset_name')


def _validate_relative(value: str, field: str) -> None:
    if not _SAFE_RELATIVE.fullmatch(value):
        raise RuntimePolicyError('query_field_invalid', f'{field} is invalid', 422, f'/query/{field}')
    path = Path(value)
    if (
        path.is_absolute()
        or not value.strip()
        or '..' in path.parts
        or '://' in value
        or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', value)
        or value.startswith(('~', '//'))
    ):
        raise RuntimePolicyError('query_locator_forbidden', f'{field} must be a contained relative locator', 422, f'/query/{field}')


def _extract_evaluation_metrics(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize EvalScope report leaves into the bounded Databench metric contract."""
    reports: list[dict[str, Any]] = []

    def collect(value: Any, depth: int = 0) -> None:
        if depth > 8 or len(reports) >= 10_000:
            return
        if isinstance(value, dict):
            if isinstance(value.get('metrics'), list) and isinstance(value.get('dataset_name'), str):
                reports.append(value)
                return
            for child in value.values():
                collect(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                collect(child, depth + 1)

    collect(payload.get('result'))
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str | None, str, tuple[str, ...]]] = set()
    for report in reports:
        dataset = _metric_text(report.get('dataset_name'), 512)
        if dataset is None:
            continue
        for metric_value in report.get('metrics', []):
            if not isinstance(metric_value, dict):
                continue
            metric = _metric_text(metric_value.get('name'), 512)
            if metric is None:
                continue
            emitted_leaf = False
            categories = metric_value.get('categories')
            if isinstance(categories, list):
                for category in categories:
                    if not isinstance(category, dict):
                        continue
                    labels = _metric_categories(category.get('name'))
                    subsets = category.get('subsets')
                    if not isinstance(subsets, list):
                        continue
                    for subset in subsets:
                        if not isinstance(subset, dict) or subset.get('is_aggregate') is True:
                            continue
                        subset_name = _metric_text(subset.get('name'), 512)
                        if subset_name is None:
                            continue
                        item = _normalized_metric(
                            dataset,
                            subset_name,
                            metric,
                            subset.get('score'),
                            subset.get('num'),
                            labels,
                        )
                        key = (dataset, subset_name, metric, tuple(labels))
                        if item is not None and key not in seen:
                            normalized.append(item)
                            seen.add(key)
                            emitted_leaf = True
                            if len(normalized) >= 10_000:
                                return normalized
            if emitted_leaf:
                continue
            item = _normalized_metric(
                dataset,
                None,
                metric,
                metric_value.get('score'),
                metric_value.get('num'),
                [],
            )
            key = (dataset, None, metric, ())
            if item is not None and key not in seen:
                normalized.append(item)
                seen.add(key)
                if len(normalized) >= 10_000:
                    return normalized
    return normalized


def _normalized_metric(
    dataset: str,
    subset: str | None,
    metric: str,
    score: Any,
    sample_count: Any,
    categories: list[str],
) -> dict[str, Any] | None:
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
        normalized_score = None
    else:
        normalized_score = float(score)
    if (
        isinstance(sample_count, bool)
        or not isinstance(sample_count, int)
        or sample_count < 0
        or sample_count > 9_007_199_254_740_991
    ):
        normalized_count = None
    else:
        normalized_count = sample_count
    return {
        'dataset': dataset,
        'subset': subset,
        'metric': metric,
        'score': normalized_score,
        'sample_count': normalized_count,
        'categories': categories,
    }


def _metric_text(value: Any, maximum_bytes: int) -> str | None:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode('utf-8')) > maximum_bytes
        or _has_control(value)
    ):
        return None
    return value


def _metric_categories(value: Any) -> list[str]:
    raw = value if isinstance(value, list) else [value]
    categories: list[str] = []
    for item in raw:
        label = _metric_text(item, 128)
        if label is not None and label not in categories:
            categories.append(label)
        if len(categories) >= 64:
            break
    return categories


def _enrich_databench_report_source(
    payload: dict[str, Any],
    path: str,
    query: dict[str, str],
    manifests: TaskManifestStore,
) -> None:
    if path == '/api/v1/reports/list':
        reports = payload.get('reports')
        if not isinstance(reports, list):
            return
        for report in reports:
            if not isinstance(report, dict):
                continue
            source = _report_source_from_name(manifests, report.get('name'))
            if source is not None:
                report['databench_source'] = source
        return
    if path == '/api/v1/reports/load':
        source = _report_source_from_name(manifests, query.get('report_name'))
        if source is not None:
            payload['databench_source'] = source


def _report_source_from_name(
    manifests: TaskManifestStore,
    report_name: Any,
) -> dict[str, str | None] | None:
    if not isinstance(report_name, str):
        return None
    match = re.match(
        r'^(eval_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:$|[^0-9a-f-])',
        report_name,
    )
    if match is None:
        return None
    try:
        integration = manifests.read_integration(match.group(1))
    except RuntimePolicyError:
        return None
    if integration is None:
        return None
    return {
        'source_ref': integration.get('source_ref'),
        'dataset_version': integration['dataset_version'],
        'benchmark': 'general_qa',
    }


def _bounded_integer(value: str, field: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise RuntimePolicyError('query_field_invalid', f'{field} must be an integer', 422, f'/query/{field}') from exc
    if parsed < minimum or parsed > maximum:
        raise RuntimePolicyError('query_field_invalid', f'{field} is out of range', 422, f'/query/{field}')
    return parsed


def _has_control(value: str) -> bool:
    return any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)


def _assert_disk_capacity(runtime: RuntimeConfig) -> None:
    output_bytes = _bounded_tree_size(runtime.output_dir, runtime.output_max_bytes)
    input_bytes = _bounded_tree_size(runtime.input_dir, runtime.input_max_bytes)
    if output_bytes >= runtime.output_max_bytes or input_bytes >= runtime.input_max_bytes:
        raise RuntimePolicyError('task_disk_capacity_exceeded', 'EvalScope disk capacity is exhausted', 503)


def _bounded_tree_size(root: Path, bound: int) -> int:
    total = 0
    for directory, names, files in os.walk(root, followlinks=False):
        names[:] = [name for name in names if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            try:
                if path.is_symlink():
                    continue
                total += path.stat().st_size
            except FileNotFoundError:
                continue
            if total >= bound:
                return total
    return total


def _safe_error_code(value: str) -> str:
    normalized = re.sub(r'[^a-z0-9._-]', '_', value.lower())
    return normalized[:128] if re.match(r'^[a-z]', normalized) else 'provider_prepare_failed'
