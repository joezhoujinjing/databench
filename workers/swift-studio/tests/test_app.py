import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from databench_swift_studio.app import (
    ProbeResult,
    _load_capability_manifest,
    _validate_gradio_config,
    create_app,
)
from databench_swift_studio.config import RuntimeConfig


def runtime_config(tmp_path: Path) -> RuntimeConfig:
    repository_root = Path(__file__).resolve().parents[3]
    return RuntimeConfig.from_env(
        {
            'DATABENCH_SWIFT_CAPABILITY_MANIFEST': str(
                repository_root / 'third_party/ms-swift/runtime-capabilities.json'
            ),
            'DATABENCH_SWIFT_WORKSPACE_ROOT': str(tmp_path),
            'WEBUI_SHARE': 'false',
        }
    )


def capability_manifest():
    repository_root = Path(__file__).resolve().parents[3]
    return _load_capability_manifest(
        repository_root / 'third_party/ms-swift/runtime-capabilities.json'
    )


def shifted_component_id(value):
    return value + 1 if isinstance(value, int) and value >= 3 else value


def native_gradio_config() -> dict:
    repository_root = Path(__file__).resolve().parents[3]
    baseline = json.loads(
        (repository_root / 'third_party/ms-swift/gradio-baseline.json').read_text(
            encoding='utf-8'
        )
    )
    components = []
    for component in baseline['components']:
        if component['id'] == 3:
            components.append(
                {
                    'id': 3,
                    'type': 'html',
                    'skip_api': False,
                    'props': {'name': 'html', 'visible': True},
                }
            )
        props = {
            key: value
            for key, value in component.items()
            if key not in {'id', 'type', 'skip_api'}
        }
        components.append(
            {
                'id': shifted_component_id(component['id']),
                'type': component['type'],
                'skip_api': component['skip_api'],
                'props': props,
            }
        )
    dependencies = [
        {
            **{
                key: value
                for key, value in dependency.items()
                if key not in {'generator', 'cancel'}
            },
            'targets': [
                [shifted_component_id(target[0]), *target[1:]]
                for target in dependency['targets']
            ],
            'inputs': [shifted_component_id(value) for value in dependency['inputs']],
            'outputs': [shifted_component_id(value) for value in dependency['outputs']],
            'types': {
                'generator': dependency['generator'],
                'cancel': dependency['cancel'],
            },
        }
        for dependency in baseline['dependencies']
    ]
    return {
        'version': '5.50.0',
        'mode': 'blocks',
        'api_prefix': '/gradio_api',
        'root': 'http://127.0.0.1:7860/swift-studio',
        'components': components,
        'dependencies': dependencies,
    }


def test_health_is_ready_only_after_gradio_probe(tmp_path: Path):
    ready = create_app(runtime_config(tmp_path), probe=lambda: ProbeResult(True, 'ready'))
    response = TestClient(ready).get('/health')
    assert response.status_code == 200
    assert response.json() == {
        'status': 'ok',
        'service': 'swift-studio-provider',
        'ready': True,
        'detail': 'ready',
        'ms_swift_commit': 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d',
        'root_path': '/swift-studio',
        'capability_manifest_id': 'swift-runtime-capabilities@1',
        'capability_manifest_phase': 'S1-in-progress',
        'capability_manifest_sha256': capability_manifest().sha256,
    }
    assert response.headers['cache-control'] == 'private, no-store'

    starting = create_app(
        runtime_config(tmp_path),
        probe=lambda: ProbeResult(False, 'Gradio is starting'),
    )
    response = TestClient(starting).get('/health')
    assert response.status_code == 503
    assert response.json()['ready'] is False


def test_runtime_exposes_complete_surface_contract(tmp_path: Path):
    app = create_app(runtime_config(tmp_path), probe=lambda: ProbeResult(True, 'ready'))
    payload = TestClient(app).get('/runtime').json()
    assert payload['ready'] is True
    assert payload['root_path'] == '/swift-studio'
    assert payload['capability_manifest_id'] == 'swift-runtime-capabilities@1'
    assert payload['capability_manifest_phase'] == 'S1-in-progress'
    assert payload['capability_manifest_sha256'] == capability_manifest().sha256
    assert payload['surfaces'] == [
        'llm_train',
        'llm_rlhf',
        'llm_grpo',
        'llm_infer',
        'llm_export',
        'llm_eval',
        'llm_sample',
    ]
    assert payload['capabilities'] == ['native-full-gradio', 'runtime-health']


def test_runtime_starting_contract_does_not_claim_native_surfaces(tmp_path: Path):
    app = create_app(
        runtime_config(tmp_path),
        probe=lambda: ProbeResult(False, 'Gradio is starting'),
    )
    payload = TestClient(app).get('/runtime').json()
    assert payload['ready'] is False
    assert payload['surfaces'] == []
    assert payload['capabilities'] == ['runtime-health']


def test_rejects_a_structurally_valid_but_drifted_capability_manifest(tmp_path: Path):
    repository_root = Path(__file__).resolve().parents[3]
    payload = json.loads(
        (repository_root / 'third_party/ms-swift/runtime-capabilities.json').read_text(
            encoding='utf-8'
        )
    )
    payload['capabilities'][0]['known_limitations'].append('unexpected drift')
    path = tmp_path / 'runtime-capabilities.json'
    path.write_text(json.dumps(payload), encoding='utf-8')

    with pytest.raises(
        ValueError,
        match='Swift capability manifest does not match the image lock',
    ):
        _load_capability_manifest(path)


def test_validates_the_real_patched_gradio_contract():
    assert _validate_gradio_config(native_gradio_config(), capability_manifest()) == ProbeResult(
        True, 'ready'
    )


@pytest.mark.parametrize(
    ('mutation', 'detail'),
    [
        (
            lambda payload: payload['components'].pop(),
            'Gradio component graph does not match the patched baseline',
        ),
        (
            lambda payload: payload['components'][4]['props'].pop('elem_id'),
            'Gradio config is missing a native top-level surface',
        ),
        (
            lambda payload: payload['dependencies'][0].update(api_name='drifted_callback'),
            'Gradio callback wiring does not match the patched baseline',
        ),
        (
            lambda payload: payload['dependencies'][0].update(inputs=[999_999]),
            'Gradio callback wiring does not match the patched baseline',
        ),
        (
            lambda payload: payload.update(root='http://127.0.0.1:7860/other'),
            'Gradio root path does not match Databench',
        ),
    ],
)
def test_rejects_incomplete_or_drifted_gradio_contract(mutation, detail: str):
    payload = native_gradio_config()
    mutation(payload)
    assert _validate_gradio_config(payload, capability_manifest()) == ProbeResult(False, detail)
