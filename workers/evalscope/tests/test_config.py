from __future__ import annotations

import json
from pathlib import Path

import pytest

from databench_evalscope.config import PLOTLY_SHA256, RuntimeConfig
from databench_evalscope.errors import RuntimePolicyError


def valid_env(tmp_path: Path) -> dict[str, str]:
    deployment_root = Path(__file__).resolve().parents[3] / 'deploy' / 'evalscope'
    policy = tmp_path / 'model-endpoint-policy.json'
    policy.write_text(json.dumps({
        'profile': 'model-endpoint-policy-v1',
        'generation': 1,
        'private_network': [],
        'public_network': [],
    }), encoding='utf-8')
    return {
        'EVALSCOPE_SERVE_WEB': 'false',
        'EVALSCOPE_OUTPUT_DIR': str(tmp_path / 'outputs'),
        'EVALSCOPE_INPUT_DIR': str(tmp_path / 'inputs'),
        'EVALSCOPE_TASK_CONFIG_HMAC_KEY': 'x' * 32,
        'EVALSCOPE_OPERATOR_TOKEN': 'y' * 32,
        'EVALSCOPE_PLOTLY_ASSET_PATH': str(
            deployment_root / 'vendor' / 'plotly-2.35.2.min.js'
        ),
        'EVALSCOPE_PLOTLY_ASSET_SHA256': PLOTLY_SHA256,
        'DATABENCH_BASE_URL': 'http://api:8000',
        'DATABENCH_ORIGIN': 'https://databench.example',
        'EVALSCOPE_MODEL_ENDPOINT_POLICY': str(policy),
    }


def test_runtime_config_is_fail_closed_and_path_separated(tmp_path: Path) -> None:
    env = valid_env(tmp_path)
    config = RuntimeConfig.from_env(env)
    config.prepare()
    assert config.output_dir.is_dir()
    assert config.input_dir.is_dir()
    assert config.model_endpoint_policy_path == tmp_path / 'model-endpoint-policy.json'
    assert config.model_credentials_path is None
    assert config.archive_max_bytes == 1024 * 1024 * 1024
    assert config.task_runtime_seconds == 24 * 60 * 60
    assert config.evaluation_sample_limit_max == 100_000
    assert config.evaluation_batch_size_max == 256
    assert config.evaluation_repeats_max == 10
    assert config.performance_parallel_max == 256
    assert config.performance_requests_max == 1_000_000
    assert config.performance_rate_max == 10_000
    assert config.model_tokens_max == 32_768
    assert config.request_timeout_seconds_max == 3_600

    credential_path = tmp_path / 'model-credentials.json'
    configured = RuntimeConfig.from_env({**env, 'EVALSCOPE_MODEL_CREDENTIALS': str(credential_path)})
    assert configured.model_credentials_path == credential_path

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
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_MODEL_ENDPOINT_POLICY': 'relative.json'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_ARCHIVE_MAX_BYTES': str(1024 * 1024 * 1024 + 1)})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_MAX_CONCURRENT_EVALS': '17'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_OUTPUT_MAX_BYTES': str(16 * 1024 * 1024 * 1024 + 1)})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_TASK_RUNTIME_SECONDS': str(24 * 60 * 60 + 1)})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_PERFORMANCE_PARALLEL_MAX': '1025'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_EVALUATION_REPEATS_MAX': '101'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_REQUEST_TIMEOUT_SECONDS_MAX': '86401'})


def test_config_response_origins_and_plotly_digest_are_exact(tmp_path: Path) -> None:
    env = valid_env(tmp_path)
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'DATABENCH_ORIGIN': 'https://example.test/path'})
    with pytest.raises(RuntimePolicyError):
        RuntimeConfig.from_env({**env, 'EVALSCOPE_PLOTLY_ASSET_SHA256': '0' * 64})
