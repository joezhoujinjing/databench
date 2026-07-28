from __future__ import annotations

import threading
from pathlib import Path

import pytest

from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.storage import ProcessRegistry, TaskManifestStore, config_digest

EVAL_ID = 'eval_123e4567-e89b-42d3-a456-426614174000'
PERF_ID = 'perf_123e4567-e89b-42d3-a456-426614174001'


def test_atomic_claim_race_replay_and_mismatch(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = TaskManifestStore(root)
    digest = config_digest({'secret': 'not-persisted', 'model': 'm'}, b'x' * 32)
    assert store.has_claim(EVAL_ID) is False
    barrier = threading.Barrier(2)
    results: list[str] = []

    def claim() -> None:
        barrier.wait()
        results.append(store.claim(EVAL_ID, 'evaluation', digest).disposition)

    threads = [threading.Thread(target=claim) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ['already_running', 'created']
    assert store.has_claim(EVAL_ID) is True
    assert 'not-persisted' not in (root / EVAL_ID / 'task-claim.json').read_text()

    with pytest.raises(RuntimePolicyError) as captured:
        store.claim(EVAL_ID, 'evaluation', config_digest({'model': 'different'}, b'x' * 32))
    assert captured.value.code == 'task_id_conflict'

    store.mark_running(EVAL_ID)
    store.record_terminal(EVAL_ID, 'completed', metrics=[], provider_report_ids=[EVAL_ID])
    assert store.claim(EVAL_ID, 'evaluation', digest).disposition == 'terminal_replay'


def test_stop_intent_wins_over_concurrent_failure(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = TaskManifestStore(root)
    digest = config_digest({'model': 'm'}, b'x' * 32)
    store.claim(EVAL_ID, 'evaluation', digest)
    store.mark_running(EVAL_ID)
    store.request_stop(EVAL_ID)
    terminal = store.record_terminal(
        EVAL_ID,
        'failed',
        error={'phase': 'provider_run', 'code': 'provider_failed', 'message': 'generic failure'},
    )
    assert terminal['phase'] == 'cancelled'
    assert terminal['terminal']['error'] == {
        'phase': 'provider_stop',
        'code': 'user_cancelled',
        'message': 'Task was cancelled',
    }


def test_reconcile_terminal_callback_stop_and_interruption(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = TaskManifestStore(root)
    integration = _integration(EVAL_ID)
    store.claim(EVAL_ID, 'evaluation', config_digest({'one': 1}, b'x' * 32))
    store.write_integration(EVAL_ID, integration)
    store.request_stop(EVAL_ID)
    callbacks: list[str] = []
    result = store.reconcile_all(lambda manifest, _integration: callbacks.append(manifest['phase']) or True)
    assert result.cancelled == 1
    assert callbacks == ['cancelled']
    assert store.read(EVAL_ID)['callback_confirmed'] is True

    store.claim(PERF_ID, 'performance', config_digest({'two': 2}, b'x' * 32))
    result = store.reconcile_all(lambda _manifest, _integration: True)
    assert result.interrupted == 1
    manifest = store.read(PERF_ID)
    assert manifest['phase'] == 'failed'
    assert manifest['terminal']['error']['code'] == 'provider_interrupted'


def test_manual_reconcile_preserves_callback_loss_for_retry(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = TaskManifestStore(root)
    store.claim(EVAL_ID, 'evaluation', config_digest({'one': 1}, b'x' * 32))
    store.write_integration(EVAL_ID, _integration(EVAL_ID))
    store.record_terminal(EVAL_ID, 'failed')
    with pytest.raises(RuntimePolicyError) as captured:
        store.reconcile_one(EVAL_ID, lambda _manifest, _integration: False)
    assert captured.value.code == 'databench_callback_unavailable'
    assert store.read(EVAL_ID)['callback_confirmed'] is False
    assert store.reconcile_one(EVAL_ID, lambda _manifest, _integration: True)['callback_confirmed'] is True


def test_integration_manifest_accepts_v1_and_v2_without_endpoint_material(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = TaskManifestStore(root)
    store.claim(EVAL_ID, 'evaluation', config_digest({'one': 1}, b'x' * 32))
    assert store.write_integration(EVAL_ID, _integration(EVAL_ID))['schema_version'] == 1

    second = 'eval_123e4567-e89b-42d3-a456-426614174009'
    store.claim(second, 'evaluation', config_digest({'two': 2}, b'x' * 32))
    persisted = store.write_integration(second, _deployment_integration(second))
    assert persisted['schema_version'] == 2
    serialized = (root / second / 'databench-integration.json').read_text()
    assert 'api_url' not in serialized
    assert 'endpoint' not in serialized
    assert '127.0.0.1' not in serialized


def test_process_registry_never_overwrites() -> None:
    registry = ProcessRegistry()
    first = object()
    registry.register(EVAL_ID, first)
    with pytest.raises(RuntimePolicyError) as captured:
        registry.register(EVAL_ID, object())
    assert captured.value.code == 'process_registry_conflict'
    assert registry.get(EVAL_ID) is first
    registry.unregister(EVAL_ID, object())
    assert registry.get(EVAL_ID) is first
    registry.unregister(EVAL_ID, first)
    assert registry.get(EVAL_ID) is None


def test_manifest_validation_rejects_credentials_and_unbounded_metrics(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = TaskManifestStore(root)
    store.claim(EVAL_ID, 'evaluation', config_digest({'one': 1}, b'x' * 32))
    with pytest.raises(RuntimePolicyError):
        store.record_terminal(
            EVAL_ID,
            'completed',
            metrics=[{
                'dataset': 'api_key=secret-value',
                'subset': None,
                'metric': 'accuracy',
                'score': 1.0,
                'sample_count': 1,
                'categories': [],
            }],
            provider_report_ids=[],
        )
    assert store.read(EVAL_ID)['phase'] == 'preparing'


def _integration(task_id: str) -> dict[str, object]:
    return {
        'schema_version': 1,
        'task_id': task_id,
        'run_id': '123e4567-e89b-42d3-a456-426614174099',
        'source_ref': 'support-qa',
        'dataset_version': 'a' * 64,
        'converter': 'evalscope-general-qa',
        'options': {'target_source': 'none'},
        'accepted_fidelity_digest': 'b' * 64,
        'model_name': 'model',
        'evalscope_commit': 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
        'input_filename': 'databench.jsonl',
    }


def _deployment_integration(task_id: str) -> dict[str, object]:
    return {
        **_integration(task_id),
        'schema_version': 2,
        'model_deployment_id': '223e4567-e89b-42d3-a456-426614174000',
        'model_artifact_id': '323e4567-e89b-42d3-a456-426614174000',
        'model_deployment_digest': 'd' * 64,
        'model_name': 'deployed-lora-v1',
    }
