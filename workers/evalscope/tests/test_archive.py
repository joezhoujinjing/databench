from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

import pytest
import zstandard

from databench_evalscope.archive import package_result_archive
from databench_evalscope.errors import RuntimePolicyError

TASK_ID = 'eval_123e4567-e89b-42d3-a456-426614174001'
RUN_ID = '123e4567-e89b-42d3-a456-426614174099'


def test_archive_bytes_are_deterministic_and_allowlisted(tmp_path: Path) -> None:
    task = tmp_path / TASK_ID
    (task / 'reports').mkdir(parents=True)
    (task / 'predictions').mkdir()
    (task / 'logs').mkdir()
    (task / 'reports' / 'summary.json').write_text(
        json.dumps({'accuracy': 1.0}, ensure_ascii=False),
        encoding='utf-8',
    )
    (task / 'predictions' / 'rows.jsonl').write_text('{"score":1}\n', encoding='utf-8')
    (task / 'logs' / 'secret.log').write_text('Authorization: hidden', encoding='utf-8')
    (task / 'task_config.yaml').write_text('api_key: hidden', encoding='utf-8')

    first = package_result_archive(
        task,
        task_id=TASK_ID,
        run_id=RUN_ID,
        provider_report_ids=[TASK_ID],
        max_bytes=1024 * 1024,
    )
    first_bytes = first.path.read_bytes()
    first.cleanup()
    second = package_result_archive(
        task,
        task_id=TASK_ID,
        run_id=RUN_ID,
        provider_report_ids=[TASK_ID],
        max_bytes=1024 * 1024,
    )
    try:
        assert second.path.read_bytes() == first_bytes
        decompressed = zstandard.ZstdDecompressor().decompress(
            first_bytes,
            max_output_size=1024 * 1024,
        )
        with tarfile.open(fileobj=io.BytesIO(decompressed), mode='r:') as archive:
            names = archive.getnames()
            assert names == sorted(names, key=lambda name: name.encode('utf-8'))
            assert names == [
                'databench-result-manifest.json',
                'predictions/rows.jsonl',
                'reports/summary.json',
            ]
            for member in archive.getmembers():
                assert member.mtime == 0
                assert member.uid == member.gid == 0
                assert member.mode == 0o640
    finally:
        second.cleanup()


@pytest.mark.parametrize(
    'payload',
    [
        {'api_key': 'hidden'},
        {'nested': {'authorization': 'Bearer hidden'}},
        {'message': 'sk-proj-1234567890abcdef'},
    ],
)
def test_archive_rejects_structured_credentials(tmp_path: Path, payload: dict[str, object]) -> None:
    task = tmp_path / TASK_ID
    (task / 'reports').mkdir(parents=True)
    (task / 'reports' / 'summary.json').write_text(json.dumps(payload), encoding='utf-8')
    with pytest.raises(RuntimePolicyError) as captured:
        package_result_archive(
            task,
            task_id=TASK_ID,
            run_id=RUN_ID,
            provider_report_ids=[],
            max_bytes=1024 * 1024,
        )
    assert captured.value.code == 'archive_secret_detected'


def test_archive_rejects_links_and_oversize(tmp_path: Path) -> None:
    task = tmp_path / TASK_ID
    (task / 'reports').mkdir(parents=True)
    outside = tmp_path / 'outside.json'
    outside.write_text('{}', encoding='utf-8')
    (task / 'reports' / 'escape.json').symlink_to(outside)
    with pytest.raises(RuntimePolicyError) as linked:
        package_result_archive(
            task,
            task_id=TASK_ID,
            run_id=RUN_ID,
            provider_report_ids=[],
            max_bytes=1024,
        )
    assert linked.value.code == 'archive_file_invalid'

    (task / 'reports' / 'escape.json').unlink()
    (task / 'reports' / 'large.json').write_bytes(b'x' * 2048)
    with pytest.raises(RuntimePolicyError) as oversized:
        package_result_archive(
            task,
            task_id=TASK_ID,
            run_id=RUN_ID,
            provider_report_ids=[],
            max_bytes=1024,
        )
    assert oversized.value.code == 'archive_too_large'
