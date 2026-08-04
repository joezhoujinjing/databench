from __future__ import annotations

import pytest

from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.security import (
    validate_dataset_args,
    validate_task_id,
)


@pytest.mark.parametrize(
    'value',
    [
        {'localPath': 'data'},
        {'LOCAL-PATH': 'data'},
        {'nested': [{'repository_id': 'dataset'}]},
        {'nested': {'sourceURL': 'value'}},
        {'nested': {'ordinary': '/etc/passwd'}},
        {'ordinary': r'C:\\data\\file.json'},
        {'ordinary': r'\\server\\share\\file.json'},
        {'ordinary': '../data'},
        {'ordinary': 'file:dataset.json'},
        {'ordinary': 'https://example.test/data'},
    ],
)
def test_dataset_args_reject_every_locator_family(value: object) -> None:
    with pytest.raises(RuntimePolicyError) as captured:
        validate_dataset_args(value)
    assert captured.value.code == 'dataset_args_locator_forbidden'
    assert captured.value.field.startswith('/dataset_args')


def test_dataset_args_preserve_non_locator_json() -> None:
    validate_dataset_args({'subset_list': ['test'], 'fewShotNum': 3, 'filters': {'language': 'zh'}})
    with pytest.raises(RuntimePolicyError) as captured:
        validate_dataset_args([])
    assert captured.value.code == 'dataset_args_invalid'


def test_task_id_is_exact_uuid_v4() -> None:
    value = 'eval_123e4567-e89b-42d3-a456-426614174000'
    assert validate_task_id(value) == value
    for invalid in ('eval_../x', 'task_123e4567-e89b-42d3-a456-426614174000', 'eval_123'):
        with pytest.raises(RuntimePolicyError):
            validate_task_id(invalid)
