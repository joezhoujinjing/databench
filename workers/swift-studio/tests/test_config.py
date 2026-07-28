from pathlib import Path

import pytest

from databench_swift_studio.config import RuntimeConfig


def test_defaults_are_private_container_runtime(tmp_path: Path):
    config = RuntimeConfig.from_env(
        {
            'DATABENCH_SWIFT_WORKSPACE_ROOT': str(tmp_path),
            'WEBUI_SHARE': 'false',
        }
    )
    assert config.gradio_port == 7860
    assert config.provider_port == 7861
    assert config.root_path == '/swift-studio'
    assert config.capability_manifest_path == Path(
        '/opt/databench-swift-studio/runtime-capabilities.json'
    )
    config.prepare()
    assert (tmp_path / 'inputs').is_dir()
    assert (tmp_path / 'outputs').is_dir()


@pytest.mark.parametrize(
    ('name', 'value'),
    [
        ('WEBUI_SHARE', 'true'),
        ('DATABENCH_SWIFT_ROOT_PATH', '/other'),
        ('WEBUI_SERVER', '127.0.0.1'),
        ('DATABENCH_SWIFT_PROVIDER_PORT', '7860'),
        ('DATABENCH_SWIFT_WORKSPACE_ROOT', 'relative'),
        ('DATABENCH_SWIFT_CAPABILITY_MANIFEST', 'relative.json'),
    ],
)
def test_rejects_incoherent_runtime_config(tmp_path: Path, name: str, value: str):
    env = {
        'DATABENCH_SWIFT_WORKSPACE_ROOT': str(tmp_path),
        'WEBUI_SHARE': 'false',
        name: value,
    }
    with pytest.raises(ValueError):
        RuntimeConfig.from_env(env)
