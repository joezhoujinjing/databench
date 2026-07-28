import json
import threading
import time
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from blake3 import blake3
from fastapi.testclient import TestClient

from databench_swift_studio.app import ProbeResult, create_app
from databench_swift_studio.artifact_imports import (
    ArtifactImportManager,
    provider_artifact_import_id,
)
from databench_swift_studio.artifacts import (
    ArtifactCore,
    ArtifactSessionContext,
)
from databench_swift_studio.config import RuntimeConfig
from databench_swift_studio.errors import ProviderError

SESSION_ID = 'sws_' + 'a' * 43
REQUEST_ID = '12' * 32
DATASET_VERSION = 'ab' * 32
EXPORT_BYTES = b'{}\n'
EXPORT_DIGEST = blake3(EXPORT_BYTES).hexdigest()
STAGING_KEY = (
    'staging/swift-artifact/v1/'
    '11111111-1111-4111-8111-111111111111/archive.tar.zst'
)
UPLOAD_URL = 'http://objects.internal/upload?X-Amz-Signature=must-not-persist'


class Contexts:
    def __init__(self, context: ArtifactSessionContext):
        self.context = context

    @property
    def provider_generation(self) -> str:
        return self.context.provider_generation

    def artifact_context(self, provider_session_id: str) -> ArtifactSessionContext:
        if provider_session_id != self.context.provider_session_id:
            raise ProviderError('provider_session_not_current', 'not current', 409)
        return self.context


def runtime_config(tmp_path: Path) -> RuntimeConfig:
    repository_root = Path(__file__).resolve().parents[3]
    config = RuntimeConfig.from_env(
        {
            'DATABENCH_SWIFT_CAPABILITY_MANIFEST': str(
                repository_root / 'third_party/ms-swift/runtime-capabilities.json'
            ),
            'DATABENCH_SWIFT_WORKSPACE_ROOT': str(tmp_path),
            'DATABENCH_API_BASE_URL': 'http://databench.internal:8000',
            'WEBUI_SHARE': 'false',
        }
    )
    config.prepare()
    return config


def artifact_context(tmp_path: Path) -> ArtifactSessionContext:
    root = tmp_path / 'sessions' / SESSION_ID
    (root / 'input').mkdir(parents=True)
    (root / 'output').mkdir()
    (root / 'input' / 'ms-swift.jsonl').write_bytes(EXPORT_BYTES)
    return ArtifactSessionContext(
        provider_generation='spg_test_generation',
        provider_session_id=SESSION_ID,
        session_root=root,
        dataset_version=DATASET_VERSION,
        export_digest=EXPORT_DIGEST,
        export_size_bytes=len(EXPORT_BYTES),
        output_count=1,
    )


def write_json(path: Path, value) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')),
        encoding='utf-8',
    )


def safetensors_bytes(tensors: dict[str, bytes]) -> bytes:
    offset = 0
    header = {}
    payload = bytearray()
    for name, data in tensors.items():
        assert len(data) > 0 and len(data) % 4 == 0
        header[name] = {
            'dtype': 'F32',
            'shape': [len(data) // 4],
            'data_offsets': [offset, offset + len(data)],
        }
        offset += len(data)
        payload.extend(data)
    raw_header = json.dumps(
        header,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    raw_header += b' ' * (-len(raw_header) % 8)
    return len(raw_header).to_bytes(8, byteorder='little') + raw_header + payload


def valid_candidate(context: ArtifactSessionContext) -> Path:
    candidate = context.session_root / 'output' / 'run' / 'checkpoint-2'
    candidate.mkdir(parents=True)
    write_json(
        candidate / 'adapter_config.json',
        {
            'base_model_name_or_path': 'Qwen/Qwen3-0.6B',
            'lora_alpha': 16,
            'lora_dropout': 0.05,
            'peft_type': 'LORA',
            'r': 8,
            'task_type': 'CAUSAL_LM',
        },
    )
    (candidate / 'adapter_model.safetensors').write_bytes(
        safetensors_bytes({'base_model.layers.0.lora_A.weight': b'\x00\x00\x00\x00'})
    )
    write_json(
        candidate / 'args.json',
        {
            'dataset': [str(context.session_root / 'input' / 'ms-swift.jsonl')],
            'max_steps': 2,
            'model': 'Qwen/Qwen3-0.6B',
            'token': 'must-not-leak',
            'train_type': 'sft',
            'tuner_type': 'lora',
        },
    )
    (candidate / 'training_args.bin').write_bytes(b'LOCKED-MS-SWIFT-TRAINING-ARGS')
    return candidate


def import_payload(handle: str, *, display_name: str = 'checkpoint-2') -> dict:
    return {
        'request_id': REQUEST_ID,
        'provider_session_id': SESSION_ID,
        'output_handle': handle,
        'artifact_kind': 'lora_adapter',
        'display_name': display_name,
        'base_model': {
            'reference': 'Qwen/Qwen3-0.6B',
            'revision': None,
        },
        'staging_object_key': STAGING_KEY,
        'staging_max_size_bytes': 16 * 1024 * 1024 * 1024,
        'staging_upload_url': UPLOAD_URL,
        'staging_upload_expires_at': '2099-01-01T00:00:00Z',
    }


def provider_client(
    tmp_path: Path,
    uploader,
) -> tuple[TestClient, ArtifactCore, Contexts, ArtifactImportManager]:
    config = runtime_config(tmp_path)
    contexts = Contexts(artifact_context(tmp_path))
    core = ArtifactCore(contexts)
    manager = ArtifactImportManager(
        core,
        state_root=config.workspace_root / 'artifact-imports',
        uploader=uploader,
    )
    app = create_app(
        config,
        probe=lambda: ProbeResult(True, 'ready'),
        session_store=contexts,
        artifact_core=core,
        artifact_imports=manager,
    )
    return TestClient(app, raise_server_exceptions=False), core, contexts, manager


def wait_for_terminal(client: TestClient, provider_import_id: str) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f'/artifact-imports/{provider_import_id}')
        assert response.status_code == 200
        body = response.json()
        if body['status'] in {'staged', 'failed'}:
            return body
        time.sleep(0.01)
    raise AssertionError('Artifact import did not reach a terminal state')


def test_output_http_contract_and_non_importable_candidate(tmp_path: Path):
    uploaded = []
    client, _, contexts, _ = provider_client(
        tmp_path,
        lambda url, path, size: uploaded.append((url, path, size)),
    )
    candidate = valid_candidate(contexts.context)

    ready = client.get(f'/sessions/{SESSION_ID}/outputs')
    assert ready.status_code == 200
    body = ready.json()
    assert body['provider_session_id'] == SESSION_ID
    assert body['provider_generation'] == 'spg_test_generation'
    assert len(body['items']) == 1
    output = body['items'][0]
    assert output['importable'] is True
    assert output['handle'].startswith('swo_')
    assert output['candidate_kinds'] == ['lora_adapter']
    assert str(tmp_path) not in json.dumps(body)

    (candidate / 'training.pkl').write_bytes(b'pickle')
    blocked = client.get(f'/sessions/{SESSION_ID}/outputs')
    assert blocked.status_code == 200
    blocked_output = blocked.json()['items'][0]
    assert blocked_output['importable'] is False
    assert blocked_output['handle'] is None
    assert blocked_output['candidate_kinds'] == []
    assert blocked_output['output_snapshot_digest'] is None
    assert blocked_output['reason'] == 'output_candidate_unknown_file'
    assert uploaded == []


def test_create_get_upload_terminal_replay_and_restart(tmp_path: Path):
    uploaded: list[tuple[str, bytes, int]] = []

    def uploader(url: str, path: Path, size: int) -> None:
        raw = path.read_bytes()
        assert len(raw) == size
        uploaded.append((url, raw, size))

    client, core, contexts, _ = provider_client(tmp_path, uploader)
    valid_candidate(contexts.context)
    output = client.get(f'/sessions/{SESSION_ID}/outputs').json()['items'][0]
    payload = import_payload(output['handle'])

    created = client.post(f'/sessions/{SESSION_ID}/artifact-imports', json=payload)
    assert created.status_code == 202
    assert created.json()['status'] == 'staging'
    provider_import_id = created.json()['provider_import_id']
    assert provider_import_id == provider_artifact_import_id(REQUEST_ID)

    terminal = wait_for_terminal(client, provider_import_id)
    assert terminal['status'] == 'staged'
    assert terminal['archive_size_bytes'] == uploaded[0][2]
    assert terminal['provider_metadata']['archive_digest'] == terminal['archive_digest']
    assert terminal['provider_metadata']['dataset_lineage'] == {
        'status': 'verified',
        'dataset_version': DATASET_VERSION,
        'dataset_export_digest': EXPORT_DIGEST,
    }
    assert uploaded[0][0] == UPLOAD_URL
    assert 'must-not-leak' not in json.dumps(terminal)
    assert UPLOAD_URL not in json.dumps(terminal)

    state_root = tmp_path / 'artifact-imports' / provider_import_id
    terminal_text = (state_root / 'terminal.json').read_text()
    assert UPLOAD_URL not in terminal_text
    assert 'must-not-leak' not in terminal_text
    assert not (state_root / 'archive.tar.zst').exists()

    replay = client.post(f'/sessions/{SESSION_ID}/artifact-imports', json=payload)
    assert replay.status_code == 200
    assert replay.json() == {**terminal, 'replayed': True}
    assert len(uploaded) == 1

    restarted = ArtifactImportManager(
        core,
        state_root=tmp_path / 'artifact-imports',
        uploader=lambda *_: pytest.fail('terminal replay must not upload again'),
    )
    contexts.context = replace(
        contexts.context,
        provider_generation='spg_after_restart',
    )
    assert restarted.get(provider_import_id) == terminal


def test_request_id_body_conflict_and_generation_mismatch(tmp_path: Path):
    client, _, contexts, _ = provider_client(tmp_path, lambda *_: None)
    valid_candidate(contexts.context)
    handle = client.get(f'/sessions/{SESSION_ID}/outputs').json()['items'][0]['handle']
    assert client.post(
        f'/sessions/{SESSION_ID}/artifact-imports',
        json=import_payload(handle),
    ).status_code == 202

    conflict = client.post(
        f'/sessions/{SESSION_ID}/artifact-imports',
        json=import_payload(handle, display_name='different'),
    )
    assert conflict.status_code == 409
    assert conflict.json()['error']['code'] == 'artifact_import_request_reuse_conflict'

    other_client, _, other_contexts, _ = provider_client(
        tmp_path / 'other',
        lambda *_: None,
    )
    valid_candidate(other_contexts.context)
    stale_handle = other_client.get(f'/sessions/{SESSION_ID}/outputs').json()['items'][0][
        'handle'
    ]
    other_contexts.context = replace(
        other_contexts.context,
        provider_generation='spg_changed_generation',
    )
    stale = other_client.post(
        f'/sessions/{SESSION_ID}/artifact-imports',
        json=import_payload(stale_handle),
    )
    assert stale.status_code == 409
    assert stale.json()['error']['code'] == 'output_handle_stale'


def test_upload_failure_is_sanitized_and_replayed(tmp_path: Path):
    def rejected_upload(_: str, __: Path, ___: int) -> None:
        raise ProviderError(
            'artifact_staging_upload_rejected',
            'Artifact staging upload was rejected',
            502,
        )

    client, _, contexts, _ = provider_client(tmp_path, rejected_upload)
    valid_candidate(contexts.context)
    handle = client.get(f'/sessions/{SESSION_ID}/outputs').json()['items'][0]['handle']
    payload = import_payload(handle)
    created = client.post(f'/sessions/{SESSION_ID}/artifact-imports', json=payload)
    terminal = wait_for_terminal(client, created.json()['provider_import_id'])

    assert terminal['status'] == 'failed'
    assert terminal['failure'] == {
        'phase': 'provider',
        'code': 'artifact_staging_upload_rejected',
        'message': 'Artifact staging upload was rejected',
    }
    assert terminal['archive_digest'] is None
    assert terminal['provider_metadata'] is None
    assert UPLOAD_URL not in json.dumps(terminal)

    replay = client.post(f'/sessions/{SESSION_ID}/artifact-imports', json=payload)
    assert replay.status_code == 200
    assert replay.json() == {**terminal, 'replayed': True}


def test_archive_size_limit_is_enforced_before_signed_upload(tmp_path: Path):
    uploaded = []
    client, _, contexts, _ = provider_client(
        tmp_path,
        lambda *args: uploaded.append(args),
    )
    valid_candidate(contexts.context)
    handle = client.get(f'/sessions/{SESSION_ID}/outputs').json()['items'][0]['handle']
    payload = {**import_payload(handle), 'staging_max_size_bytes': 1}
    created = client.post(f'/sessions/{SESSION_ID}/artifact-imports', json=payload)
    terminal = wait_for_terminal(client, created.json()['provider_import_id'])

    assert terminal['status'] == 'failed'
    assert terminal['failure']['code'] == 'artifact_archive_too_large'
    assert uploaded == []


def test_provider_close_rejects_an_active_artifact_import(tmp_path: Path):
    upload_started = threading.Event()
    release_upload = threading.Event()

    def blocking_upload(_: str, __: Path, ___: int) -> None:
        upload_started.set()
        assert release_upload.wait(timeout=5)

    client, _, contexts, _ = provider_client(tmp_path, blocking_upload)
    valid_candidate(contexts.context)
    handle = client.get(f'/sessions/{SESSION_ID}/outputs').json()['items'][0]['handle']
    created = client.post(
        f'/sessions/{SESSION_ID}/artifact-imports',
        json=import_payload(handle),
    )
    assert created.status_code == 202
    assert upload_started.wait(timeout=5)
    try:
        close = client.post(
            f'/sessions/{SESSION_ID}:close',
            json={'request_id': '34' * 32},
        )
        assert close.status_code == 409
        assert close.json()['error']['code'] == 'session_has_active_artifact_import'
    finally:
        release_upload.set()
    assert wait_for_terminal(client, created.json()['provider_import_id'])['status'] == 'staged'


def test_durable_started_state_recovers_interrupted_process_as_failed(tmp_path: Path):
    client, core, contexts, _ = provider_client(tmp_path, lambda *_: None)
    valid_candidate(contexts.context)
    handle = client.get(f'/sessions/{SESSION_ID}/outputs').json()['items'][0]['handle']
    created = client.post(
        f'/sessions/{SESSION_ID}/artifact-imports',
        json=import_payload(handle),
    )
    provider_import_id = created.json()['provider_import_id']
    terminal = wait_for_terminal(client, provider_import_id)
    import_root = tmp_path / 'artifact-imports' / provider_import_id
    assert (import_root / 'started.json').is_file()
    assert UPLOAD_URL not in (import_root / 'started.json').read_text()
    (import_root / 'terminal.json').unlink()

    restarted = ArtifactImportManager(
        core,
        state_root=tmp_path / 'artifact-imports',
        uploader=lambda *_: pytest.fail('interrupted state cannot replay an upload'),
    )
    recovered = restarted.get(provider_import_id)
    assert recovered == {
        **terminal,
        'status': 'failed',
        'archive_digest': None,
        'archive_size_bytes': None,
        'provider_metadata': None,
        'failure': {
            'phase': 'provider',
            'code': 'artifact_import_interrupted',
            'message': 'Artifact import was interrupted before staging completed',
        },
    }
    assert (import_root / 'terminal.json').is_file()


def test_default_signed_put_sets_exact_headers_and_maps_rejection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    archive = tmp_path / 'archive.tar.zst'
    archive.write_bytes(b'archive')
    observed = []

    def accepted(url, **options):
        observed.append((url, options))
        assert options['content'].read() == b'archive'
        return httpx.Response(200)

    monkeypatch.setattr(httpx, 'put', accepted)
    ArtifactImportManager._upload(UPLOAD_URL, archive, len(b'archive'))
    assert observed[0][0] == UPLOAD_URL
    assert observed[0][1]['headers'] == {
        'Content-Type': 'application/zstd',
        'Content-Length': str(len(b'archive')),
    }
    assert observed[0][1]['follow_redirects'] is False
    assert observed[0][1]['trust_env'] is False

    monkeypatch.setattr(httpx, 'put', lambda *_args, **_options: httpx.Response(403))
    with pytest.raises(ProviderError) as error:
        ArtifactImportManager._upload(UPLOAD_URL, archive, len(b'archive'))
    assert error.value.code == 'artifact_staging_upload_rejected'
