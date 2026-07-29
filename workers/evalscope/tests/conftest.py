from __future__ import annotations

from pathlib import Path

import pytest

from databench_evalscope.config import PLOTLY_SHA256, RuntimeConfig


@pytest.fixture
def runtime_config(tmp_path: Path) -> RuntimeConfig:
    deployment_root = Path(__file__).resolve().parents[3] / 'deploy' / 'evalscope'
    return RuntimeConfig(
        output_dir=tmp_path / 'outputs',
        input_dir=tmp_path / 'inputs',
        allowed_media_roots=(tmp_path / 'outputs', tmp_path / 'inputs'),
        task_hmac_key=b'task-hmac-key-that-is-at-least-32-bytes',
        operator_token=b'operator-token-that-is-at-least-32-bytes',
        databench_base_url='http://databench.internal:8000',
        databench_service_credential='internal-service-credential',
        databench_origin='http://databench.test',
        plotly_asset_path=deployment_root / 'vendor' / 'plotly-2.35.2.min.js',
        plotly_asset_sha256=PLOTLY_SHA256,
        endpoint_allowlist='http|127.0.0.1/32|8001',
        dataset_endpoint_allowlist='',
        model_redirect_max_hops=0,
        input_max_bytes=1024 * 1024,
        output_max_bytes=8 * 1024 * 1024,
        request_max_bytes=128 * 1024,
        response_max_bytes=2 * 1024 * 1024,
        document_max_bytes=2 * 1024 * 1024,
        document_ttl_seconds=900,
        max_concurrent_evals=2,
        max_concurrent_perf=2,
        max_tasks=100,
        archive_max_bytes=8 * 1024 * 1024,
        task_runtime_seconds=60,
        evaluation_sample_limit_max=10_000,
        evaluation_batch_size_max=64,
        evaluation_repeats_max=10,
        performance_parallel_max=64,
        performance_requests_max=100_000,
        performance_rate_max=1_000,
        model_tokens_max=16_384,
        request_timeout_seconds_max=600,
    )
