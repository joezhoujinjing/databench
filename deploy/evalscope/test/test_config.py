from __future__ import annotations

from pathlib import Path

import pytest

from databench_evalscope.config import PLOTLY_SHA256, RuntimeConfig
from databench_evalscope.errors import RuntimePolicyError


def valid_env(tmp_path: Path) -> dict[str, str]:
    root = Path(__file__).resolve().parents[1]
    return {
        'EVALSCOPE_SERVE_WEB': 'false',
        'EVALSCOPE_OUTPUT_DIR': str(tmp_path / 'outputs'),
        'EVALSCOPE_INPUT_DIR': str(tmp_path / 'inputs'),
        'EVALSCOPE_TASK_CONFIG_HMAC_KEY': 'x' * 32,
        'EVALSCOPE_OPERATOR_TOKEN': 'y' * 32,
        'EVALSCOPE_PLOTLY_ASSET_PATH': str(root / 'vendor' / 'plotly-2.35.2.min.js'),
        'EVALSCOPE_PLOTLY_ASSET_SHA256': PLOTLY_SHA256,
        'DATABENCH_BASE_URL': 'http://api:8000',
        'DATABENCH_ORIGIN': 'https://databench.example',
    }


def test_runtime_config_is_fail_closed_and_path_separated(tmp_path: Path) -> None:
    env = valid_env(tmp_path)
    config = RuntimeConfig.from_env(env)
    config.prepare()
    assert config.output_dir.is_dir()
    assert config.input_dir.is_dir()
    assert config.endpoint_allowlist == ''

    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_SERVE_WEB': 'true'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_INPUT_DIR': str(tmp_path / 'outputs' / 'nested')})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_ALLOWED_MEDIA_ROOTS': 'relative'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_MODEL_REDIRECT_MAX_HOPS': 'nope'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_MODEL_REDIRECT_MAX_HOPS': '1'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'DATABENCH_SERVICE_CREDENTIAL': 'bad\nheader'})


def test_config_response_origins_and_plotly_digest_are_exact(tmp_path: Path) -> None:
    env = valid_env(tmp_path)
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'DATABENCH_ORIGIN': 'https://example.test/path'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_PLOTLY_ASSET_SHA256': '0' * 64})
