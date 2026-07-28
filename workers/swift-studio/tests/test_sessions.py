import json
from base64 import urlsafe_b64encode
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from blake3 import blake3
from fastapi.testclient import TestClient

from databench_swift_studio.app import ProbeResult, create_app
from databench_swift_studio.config import RuntimeConfig
from databench_swift_studio.sessions import SessionStore

DATASET_VERSION = 'ab' * 32
REQUEST_ID = 'cd' * 32
OTHER_REQUEST_ID = 'ef' * 32
CLOSE_REQUEST_ID = '12' * 32
CLEANUP_REQUEST_ID = '34' * 32
EXPORT = (
    b'{"messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"}]}\n'
    b'{"messages":[{"role":"user","content":"three"},{"role":"assistant","content":"four"}]}\n'
)


def runtime_config(
    tmp_path: Path,
    *,
    credential: str | None = 'provider-secret',
) -> RuntimeConfig:
    repository_root = Path(__file__).resolve().parents[3]
    env = {
        'DATABENCH_SWIFT_CAPABILITY_MANIFEST': str(
            repository_root / 'third_party/ms-swift/runtime-capabilities.json'
        ),
        'DATABENCH_SWIFT_WORKSPACE_ROOT': str(tmp_path),
        'DATABENCH_API_BASE_URL': 'http://databench.internal:8000',
        'WEBUI_SHARE': 'false',
    }
    if credential is not None:
        env['DATABENCH_SWIFT_PROVIDER_CREDENTIAL'] = credential
    config = RuntimeConfig.from_env(env)
    config.prepare()
    return config


def create_payload(
    *,
    request_id: str = REQUEST_ID,
    export_url: str | None = None,
    digest: str | None = None,
    size_bytes: int | None = None,
    line_count: int | None = None,
) -> dict:
    return {
        'request_id': request_id,
        'dataset_version': DATASET_VERSION,
        'display_label': 'training/example · exact Dataset',
        'export_url': export_url
        or f'http://databench.internal:8000/v2/datasets/{DATASET_VERSION}:export',
        'export_request': {
            'converter': 'ms-swift',
            'options': {},
            'accepted_fidelity_digest': '56' * 32,
        },
        'expected': {
            'digest_algorithm': 'blake3',
            'digest': digest or blake3(EXPORT).hexdigest(),
            'size_bytes': len(EXPORT) if size_bytes is None else size_bytes,
            'line_count': 2 if line_count is None else line_count,
        },
        'converter_version': '1.0.0',
    }


def provider_client(
    config: RuntimeConfig,
    handler,
    *,
    active_task_probe=lambda _path: False,
) -> TestClient:
    store = SessionStore(
        config,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        native_task_probe=active_task_probe,
        provider_generation='spg_test_generation',
    )
    app = create_app(
        config,
        probe=lambda: ProbeResult(True, 'ready'),
        session_store=store,
    )
    test_client = TestClient(app, raise_server_exceptions=False)
    if config.databench_service_credential is not None:
        test_client.headers['Authorization'] = (
            f'Bearer {config.databench_service_credential}'
        )
    return test_client


def successful_export(request: httpx.Request) -> httpx.Response:
    assert request.method == 'POST'
    assert request.url == (
        f'http://databench.internal:8000/v2/datasets/{DATASET_VERSION}:export'
    )
    assert request.headers['accept-encoding'] == 'identity'
    assert request.headers['authorization'] == 'Bearer provider-secret'
    assert json.loads(request.content) == {
        'converter': 'ms-swift',
        'options': {},
        'accepted_fidelity_digest': '56' * 32,
    }
    return httpx.Response(
        200,
        headers={'Content-Type': 'application/x-ndjson'},
        content=EXPORT,
    )


def test_materializes_exact_export_and_replays_without_paths(tmp_path: Path):
    config = runtime_config(tmp_path)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return successful_export(request)

    client = provider_client(config, handler)
    created = client.post('/sessions', json=create_payload())
    assert created.status_code == 201
    body = created.json()
    assert set(body) == {
        'provider_session_id',
        'status',
        'dataset_version',
        'converter',
        'converter_version',
        'export_digest',
        'export_size_bytes',
        'output_count',
        'provider_generation',
        'replayed',
    }
    assert body == {
        'provider_session_id': body['provider_session_id'],
        'status': 'ready',
        'dataset_version': DATASET_VERSION,
        'converter': 'ms-swift',
        'converter_version': '1.0.0',
        'export_digest': blake3(EXPORT).hexdigest(),
        'export_size_bytes': len(EXPORT),
        'output_count': 2,
        'provider_generation': 'spg_test_generation',
        'replayed': False,
    }
    assert '/var/' not in json.dumps(body)

    locator = body['provider_session_id']
    assert locator == (
        'sws_'
        + urlsafe_b64encode(bytes.fromhex(REQUEST_ID)).decode('ascii').rstrip('=')
    )
    root = tmp_path / 'sessions' / locator
    assert (root / 'input/ms-swift.jsonl').read_bytes() == EXPORT
    assert (root / 'input/ms-swift.jsonl').stat().st_mode & 0o777 == 0o440
    assert not (tmp_path / 'sessions' / f'{locator}.partial').exists()
    assert not (root / 'input/ms-swift.jsonl.partial').exists()
    assert json.loads((root / 'session.json').read_text())['status'] == 'ready'
    assert str(tmp_path) not in (root / 'session.json').read_text()
    assert json.loads((root / 'input/export.json').read_text()) == {
        'schema_version': 1,
        'converter': 'ms-swift',
        'converter_version': '1.0.0',
        'dataset_version': DATASET_VERSION,
        'digest_algorithm': 'blake3',
        'export_digest': blake3(EXPORT).hexdigest(),
        'export_size_bytes': len(EXPORT),
        'output_count': 2,
        'filename': 'ms-swift.jsonl',
    }

    current = client.get('/sessions/current')
    assert current.status_code == 200
    assert current.json() == body
    context = client.get('/sessions/current/context')
    assert context.status_code == 200
    assert context.json() == {
        'provider_session_id': locator,
        'status': 'ready',
        'dataset_version': DATASET_VERSION,
        'display_label': 'training/example · exact Dataset',
        'dataset_path': str(root / 'input/ms-swift.jsonl'),
        'output_dir': str(root / 'output'),
        'logging_dir': str(root / 'logs'),
        'provider_generation': 'spg_test_generation',
    }

    replay = client.post('/sessions', json=create_payload())
    assert replay.status_code == 200
    assert replay.json() == {**body, 'replayed': True}
    assert calls == 1


def test_rejects_a_second_different_active_session(tmp_path: Path):
    client = provider_client(runtime_config(tmp_path), successful_export)
    assert client.post('/sessions', json=create_payload()).status_code == 201

    conflict = client.post(
        '/sessions',
        json=create_payload(request_id=OTHER_REQUEST_ID),
    )
    assert conflict.status_code == 409
    assert conflict.json() == {
        'error': {
            'code': 'active_session_conflict',
            'message': 'Another Swift Studio Session is already active',
        }
    }


def test_rejects_request_id_reuse_with_different_create_input(tmp_path: Path):
    config = runtime_config(tmp_path)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return successful_export(request)

    client = provider_client(config, handler)
    assert client.post('/sessions', json=create_payload()).status_code == 201
    changed = create_payload()
    changed['export_request']['accepted_fidelity_digest'] = '78' * 32

    conflict = client.post('/sessions', json=changed)

    assert conflict.status_code == 409
    assert conflict.json()['error']['code'] == 'session_request_reuse_conflict'
    assert calls == 1


@pytest.mark.parametrize(
    ('change', 'code'),
    [
        ({'digest': '00' * 32}, 'session_export_digest_mismatch'),
        ({'size_bytes': len(EXPORT) + 1}, 'session_export_size_mismatch'),
        ({'line_count': 3}, 'session_export_count_mismatch'),
    ],
)
def test_mismatch_never_exposes_partial_input(tmp_path: Path, change: dict, code: str):
    config = runtime_config(tmp_path)
    client = provider_client(config, successful_export)
    response = client.post('/sessions', json=create_payload(**change))

    assert response.status_code == 502
    assert response.json()['error']['code'] == code
    assert client.get('/sessions/current').status_code == 404
    assert list(config.sessions_root.iterdir()) == []


class InterruptedStream(httpx.SyncByteStream):
    def __iter__(self):
        yield EXPORT[:20]
        raise httpx.ReadError('simulated disconnect')


def test_interrupted_download_exactly_cleans_partial_paths(tmp_path: Path):
    config = runtime_config(tmp_path)

    def interrupted(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={'Content-Type': 'application/x-ndjson'},
            stream=InterruptedStream(),
        )

    client = provider_client(config, interrupted)
    response = client.post('/sessions', json=create_payload())
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'session_export_unavailable'
    assert list(config.sessions_root.iterdir()) == []


def test_rejects_encoded_export_body_before_exact_digesting(tmp_path: Path):
    config = runtime_config(tmp_path)

    def encoded(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                'Content-Type': 'application/x-ndjson',
                'Content-Encoding': 'gzip',
            },
            stream=httpx.ByteStream(EXPORT),
        )

    client = provider_client(config, encoded)
    response = client.post('/sessions', json=create_payload())

    assert response.status_code == 502
    assert response.json()['error']['code'] == 'session_export_protocol_invalid'
    assert list(config.sessions_root.iterdir()) == []


@pytest.mark.parametrize(
    'mutation',
    [
        lambda payload: payload.update(
            export_url=f'http://other.internal:8000/v2/datasets/{DATASET_VERSION}:export'
        ),
        lambda payload: payload.update(
            export_url=f'http://databench.internal:8000/v2/datasets/{"00" * 32}:export'
        ),
        lambda payload: payload.update(extra='rejected'),
        lambda payload: payload['export_request'].update(options={'unknown': True}),
        lambda payload: payload['expected'].update(digest_algorithm='sha256'),
    ],
)
def test_rejects_untrusted_url_and_schema_drift(tmp_path: Path, mutation):
    client = provider_client(runtime_config(tmp_path), successful_export)
    payload = create_payload()
    mutation(payload)
    response = client.post('/sessions', json=payload)

    assert response.status_code == 422
    assert response.json()['error']['code'] in {
        'session_request_invalid',
        'session_export_url_rejected',
    }
    assert set(response.json()['error']) == {'code', 'message'}


def test_request_body_and_query_are_bounded(tmp_path: Path):
    config = replace(runtime_config(tmp_path), session_request_max_bytes=1024)
    client = provider_client(config, successful_export)
    response = client.post(
        '/sessions',
        content=b'{' + b' ' * 2048 + b'}',
        headers={'Content-Type': 'application/json'},
    )
    assert response.status_code == 413
    assert response.json()['error']['code'] == 'request_too_large'
    assert client.get('/sessions/current?leak=true').status_code == 400


def test_session_control_requires_the_configured_bearer(tmp_path: Path):
    client = provider_client(runtime_config(tmp_path), successful_export)
    del client.headers['Authorization']
    response = client.post('/sessions', json=create_payload())

    assert response.status_code == 401
    assert response.json() == {
        'error': {
            'code': 'provider_auth_required',
            'message': 'Swift Studio Provider authentication is required',
        }
    }


def test_close_blocks_active_task_then_exact_cleanup_preserves_output(tmp_path: Path):
    active = True

    def probe(_: Path) -> bool:
        return active

    config = runtime_config(tmp_path)
    client = provider_client(config, successful_export, active_task_probe=probe)
    created = client.post('/sessions', json=create_payload()).json()
    locator = created['provider_session_id']
    root = config.sessions_root / locator
    output = root / 'output' / 'keep-adapter.safetensors'
    output.write_bytes(b'adapter')

    blocked = client.post(
        f'/sessions/{locator}:close',
        json={'request_id': CLOSE_REQUEST_ID},
    )
    assert blocked.status_code == 409
    assert blocked.json()['error']['code'] == 'session_has_active_tasks'

    active = False
    closed = client.post(
        f'/sessions/{locator}:close',
        json={'request_id': CLOSE_REQUEST_ID},
    )
    assert closed.status_code == 202
    assert closed.json() == {
        'provider_session_id': locator,
        'status': 'closed',
        'provider_generation': 'spg_test_generation',
        'replayed': False,
    }
    assert client.get('/sessions/current').status_code == 404
    replay = client.post(
        f'/sessions/{locator}:close',
        json={'request_id': CLOSE_REQUEST_ID},
    )
    assert replay.status_code == 200
    assert replay.json()['replayed'] is True

    cleaned = client.post(
        f'/sessions/{locator}:cleanup',
        json={'request_id': CLEANUP_REQUEST_ID},
    )
    assert cleaned.status_code == 202
    assert cleaned.json() == {
        'provider_session_id': locator,
        'status': 'cleaned',
        'provider_generation': 'spg_test_generation',
        'replayed': False,
    }
    assert not (root / 'input').exists()
    assert not (root / 'tmp').exists()
    assert output.read_bytes() == b'adapter'
    assert (root / 'session.json').is_file()


def test_cleanup_rejects_unknown_exact_input_without_deleting_it(tmp_path: Path):
    config = runtime_config(tmp_path)
    client = provider_client(config, successful_export)
    locator = client.post('/sessions', json=create_payload()).json()[
        'provider_session_id'
    ]
    assert (
        client.post(
            f'/sessions/{locator}:close',
            json={'request_id': CLOSE_REQUEST_ID},
        ).status_code
        == 202
    )
    unknown = config.sessions_root / locator / 'input' / 'unexpected.bin'
    unknown.write_bytes(b'keep')

    response = client.post(
        f'/sessions/{locator}:cleanup',
        json={'request_id': CLEANUP_REQUEST_ID},
    )
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'session_cleanup_rejected'
    assert unknown.read_bytes() == b'keep'
    assert (config.sessions_root / locator / 'input/ms-swift.jsonl').is_file()


def test_restart_recovers_current_session_from_atomic_manifest(tmp_path: Path):
    config = runtime_config(tmp_path)
    first = provider_client(config, successful_export)
    created = first.post('/sessions', json=create_payload()).json()

    second = provider_client(config, successful_export)
    current = second.get('/sessions/current')
    assert current.status_code == 200
    assert current.json() == {
        **created,
        'provider_generation': 'spg_test_generation',
        'replayed': False,
    }


def test_restart_finishes_pointer_after_final_session_rename(tmp_path: Path):
    config = runtime_config(tmp_path)
    first = provider_client(config, successful_export)
    created = first.post('/sessions', json=create_payload()).json()
    locator = created['provider_session_id']
    current_path = config.sessions_root / 'current.json'
    current = json.loads(current_path.read_text())
    current['partial'] = True
    current_path.write_text(json.dumps(current))
    leftover_partial = config.sessions_root / f'{locator}.partial'
    leftover_partial.mkdir()
    (leftover_partial / 'unpublished').write_bytes(b'partial')

    second = provider_client(config, successful_export)
    recovered = second.get('/sessions/current')

    assert recovered.status_code == 200
    assert recovered.json()['provider_session_id'] == locator
    assert json.loads(current_path.read_text())['partial'] is False
    assert not leftover_partial.exists()


def test_retry_reclaims_exact_partial_when_pointer_was_not_published(tmp_path: Path):
    config = runtime_config(tmp_path)
    locator = (
        'sws_'
        + urlsafe_b64encode(bytes.fromhex(REQUEST_ID)).decode('ascii').rstrip('=')
    )
    partial_root = config.sessions_root / f'{locator}.partial'
    partial_root.mkdir()
    (partial_root / 'unpublished').write_bytes(b'partial')
    (config.sessions_root / 'current.json.partial').write_text('{"incomplete":')

    client = provider_client(config, successful_export)
    created = client.post('/sessions', json=create_payload())

    assert created.status_code == 201
    assert created.json()['provider_session_id'] == locator
    assert not partial_root.exists()
    assert (config.sessions_root / locator / 'input/ms-swift.jsonl').is_file()


def test_restart_reconciles_closed_manifest_before_pointer_removal(tmp_path: Path):
    config = runtime_config(tmp_path)
    first = provider_client(config, successful_export)
    locator = first.post('/sessions', json=create_payload()).json()[
        'provider_session_id'
    ]
    root = config.sessions_root / locator
    session_path = root / 'session.json'
    manifest = json.loads(session_path.read_text())
    session_path.write_text(
        json.dumps(
            {
                **manifest,
                'status': 'closed',
                'close_request_id': CLOSE_REQUEST_ID,
            }
        )
    )

    second = provider_client(config, successful_export)

    assert second.get('/sessions/current').status_code == 404
    replay = second.post(
        f'/sessions/{locator}:close',
        json={'request_id': CLOSE_REQUEST_ID},
    )
    assert replay.status_code == 200
    assert replay.json()['replayed'] is True
    assert not (config.sessions_root / 'current.json').exists()


def test_cleanup_retries_after_delete_before_terminal_manifest(tmp_path: Path):
    config = runtime_config(tmp_path)
    first = provider_client(config, successful_export)
    locator = first.post('/sessions', json=create_payload()).json()[
        'provider_session_id'
    ]
    assert (
        first.post(
            f'/sessions/{locator}:close',
            json={'request_id': CLOSE_REQUEST_ID},
        ).status_code
        == 202
    )
    root = config.sessions_root / locator
    session_path = root / 'session.json'
    pending = {
        **json.loads(session_path.read_text()),
        'cleanup_request_id': CLEANUP_REQUEST_ID,
    }
    session_path.write_text(json.dumps(pending))
    (root / 'input/ms-swift.jsonl').unlink()
    (root / 'input/export.json').unlink()
    (root / 'input').rmdir()
    (root / 'tmp').rmdir()
    session_path.with_name('session.json.partial').write_text(
        json.dumps({**pending, 'input_cleaned': True})
    )

    second = provider_client(config, successful_export)
    conflict = second.post(
        f'/sessions/{locator}:cleanup',
        json={'request_id': OTHER_REQUEST_ID},
    )
    assert conflict.status_code == 409
    assert conflict.json()['error']['code'] == 'session_cleanup_conflict'

    completed = second.post(
        f'/sessions/{locator}:cleanup',
        json={'request_id': CLEANUP_REQUEST_ID},
    )
    assert completed.status_code == 202
    assert completed.json()['replayed'] is False
    assert not session_path.with_name('session.json.partial').exists()
    assert json.loads(session_path.read_text())['input_cleaned'] is True
    replay = second.post(
        f'/sessions/{locator}:cleanup',
        json={'request_id': CLEANUP_REQUEST_ID},
    )
    assert replay.status_code == 200
    assert replay.json()['replayed'] is True


def test_stored_manifest_types_fail_closed(tmp_path: Path):
    config = runtime_config(tmp_path)
    client = provider_client(config, successful_export)
    locator = client.post('/sessions', json=create_payload()).json()[
        'provider_session_id'
    ]
    session_path = config.sessions_root / locator / 'session.json'
    manifest = json.loads(session_path.read_text())
    session_path.write_text(json.dumps({**manifest, 'output_count': True}))

    response = client.get('/sessions/current')

    assert response.status_code == 500
    assert response.json()['error']['code'] == 'session_state_invalid'
