from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import textwrap

import pytest

from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.model_credentials import (
    AnonymousCredentialFdHandoffV1,
    ModelCredentialRegistryV1,
    ModelCredentialsDocumentV1,
    project_model_credentials_v1,
    read_anonymous_credential_fd_v1,
)

DEPLOYMENT_A = '123e4567-e89b-42d3-a456-426614174000'
DEPLOYMENT_B = '223e4567-e89b-42d3-a456-426614174000'
SECRET = 'python-secret-value-that-must-not-leak'


def authority(generation: int = 1) -> dict:
    return {
        'profile': 'model-credentials-v1',
        'generation': generation,
        'projection_for': 'authority',
        'credentials': {
            'deployment-a': {
                'kind': 'bearer',
                'secret': SECRET,
                'allowed_consumers': ['api-health', 'evalscope'],
                'allowed_deployments': [DEPLOYMENT_A],
            },
            'evalscope-only': {
                'kind': 'bearer',
                'secret': 'evalscope-only-secret-value',
                'allowed_consumers': ['evalscope'],
                'allowed_deployments': [DEPLOYMENT_B],
            },
        },
    }


def write_projection(path: Path, generation: int) -> None:
    projection = project_model_credentials_v1(authority(generation), 'evalscope')
    temporary = path.with_suffix('.partial')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o440)
    try:
        os.write(descriptor, json.dumps(projection).encode('utf-8'))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def test_strict_parser_and_minimal_projection() -> None:
    parsed = ModelCredentialsDocumentV1.parse(authority())
    with pytest.raises(RuntimePolicyError):
        ModelCredentialsDocumentV1.parse({**authority(), 'extra': True})
    api = project_model_credentials_v1(authority(), 'api-health')
    assert list(api['credentials']) == ['deployment-a']
    evaluation = project_model_credentials_v1(authority(), 'evalscope')
    assert list(evaluation['credentials']) == ['deployment-a', 'evalscope-only']
    assert parsed.generation == 1


def test_registry_jit_acl_rotation_rollback_and_redaction(tmp_path: Path) -> None:
    path = tmp_path / 'evalscope-model-credentials.json'
    write_projection(path, 1)
    registry = ModelCredentialRegistryV1(path, 'evalscope', require_root_owner=False)
    assert registry.reload() == 1
    snapshot = registry.resolve('deployment-a', DEPLOYMENT_A)
    assert snapshot.authorization_header() == f'Bearer {SECRET}'
    with pytest.raises(RuntimePolicyError) as captured:
        registry.resolve('deployment-a', DEPLOYMENT_B)
    assert captured.value.code == 'credential_reference_forbidden'
    write_projection(path, 2)
    assert registry.reload() == 2
    write_projection(path, 1)
    with pytest.raises(RuntimePolicyError) as captured:
        registry.reload()
    assert captured.value.code == 'credential_generation_rollback_rejected'
    assert registry.reload(allow_generation_rollback=True) == 1
    text = registry.redact(f'deployment-a Authorization: Bearer {SECRET} secret={SECRET}')
    assert SECRET not in text
    assert 'deployment-a' not in text
    assert SECRET not in repr(snapshot)


def test_registry_rejects_a_projection_symlink(tmp_path: Path) -> None:
    target = tmp_path / 'projection.json'
    write_projection(target, 1)
    link = tmp_path / 'projection-link.json'
    link.symlink_to(target)
    registry = ModelCredentialRegistryV1(link, 'evalscope', require_root_owner=False)
    with pytest.raises(RuntimePolicyError) as captured:
        registry.reload()
    assert captured.value.code == 'credential_projection_unavailable'


def test_anonymous_fd_handoff_does_not_use_argv_env_or_disk(tmp_path: Path) -> None:
    path = tmp_path / 'evalscope-model-credentials.json'
    write_projection(path, 1)
    registry = ModelCredentialRegistryV1(path, 'evalscope', require_root_owner=False)
    registry.reload()
    snapshot = registry.resolve('deployment-a', DEPLOYMENT_A)
    before_env = dict(os.environ)
    with AnonymousCredentialFdHandoffV1(snapshot) as handoff:
        assert handoff.pass_fds == (handoff.read_fd,)
        assert SECRET not in repr(handoff)
        assert SECRET not in ' '.join(os.sys.argv)
        assert SECRET not in json.dumps(os.environ.copy())
        descriptor = os.dup(handoff.read_fd)
        assert read_anonymous_credential_fd_v1(descriptor) == SECRET
    assert dict(os.environ) == before_env
    assert list(tmp_path.iterdir()) == [path]


def test_patched_spawn_child_reads_exact_anonymous_fd_snapshot(tmp_path: Path) -> None:
    repository_root = Path(__file__).resolve().parents[3]
    archive = repository_root / 'deploy/evalscope/vendor/evalscope-upstream.tar.gz'
    patch = repository_root / 'deploy/evalscope/patches/0001-databench-runtime-boundary.patch'
    with tarfile.open(archive, 'r:gz') as source:
        source.extractall(tmp_path, filter='data')
    upstream = tmp_path / 'evalscope-upstream'
    applied = subprocess.run(
        ['patch', '--batch', '--forward', '-p1'],
        cwd=upstream,
        input=patch.read_bytes(),
        capture_output=True,
        check=False,
    )
    assert applied.returncode == 0, applied.stderr.decode('utf-8', errors='replace')

    probe = tmp_path / 'credential_fd_probe.py'
    probe.write_text(textwrap.dedent('''
        from secrets import token_hex

        from evalscope.config import TaskConfig
        from evalscope.service.utils.process import run_in_subprocess
        from databench_evalscope.model_credentials import (
            AnonymousCredentialFdHandoffV1,
            ModelCredentialSnapshotV1,
        )


        def reveal_credential(task_config):
            return task_config.api_key.get_secret_value()


        if __name__ == '__main__':
            secret = token_hex(32)
            snapshot = ModelCredentialSnapshotV1('runtime-test', 1, secret)
            task_config = TaskConfig.from_dict({
                'model': 'runtime-test-model',
                'datasets': ['general_qa'],
                'api_url': 'http://127.0.0.1:8001/v1',
            })
            before = task_config.api_key.get_secret_value()
            with AnonymousCredentialFdHandoffV1(snapshot) as handoff:
                observed = run_in_subprocess(
                    reveal_credential,
                    task_config,
                    credential_fd=handoff.read_fd,
                )
            assert observed == secret
            assert task_config.api_key.get_secret_value() == before
            print('fd-handoff-ok')
    '''), encoding='utf-8')
    python_path = os.pathsep.join((
        str(upstream),
        str(repository_root / 'workers/evalscope/src'),
        os.environ.get('PYTHONPATH', ''),
    ))
    result = subprocess.run(
        [sys.executable, str(probe)],
        cwd=tmp_path,
        env={**os.environ, 'PYTHONPATH': python_path},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'fd-handoff-ok'
