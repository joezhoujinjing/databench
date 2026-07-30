from __future__ import annotations

import math

import pytest

import databench_evalscope.metrics as metrics_module
from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.metrics import MetricCatalogue


@pytest.fixture
def catalogue(monkeypatch) -> MetricCatalogue:
    value = MetricCatalogue.load()
    registered = frozenset(
        descriptor['registration']['key']
        for descriptor in value._descriptors.values()
        if descriptor['registration']['kind'] == 'registry'
    )
    monkeypatch.setattr(metrics_module, '_registered_metric_keys', lambda: registered)
    return value


def test_catalogue_keeps_all_native_descriptors_and_marks_compatibility(catalogue) -> None:
    response = catalogue.response('general_qa')
    assert response['schema_version'] == 1
    assert len(response['metrics']) == 27
    by_id = {metric['id']: metric for metric in response['metrics']}
    assert by_id['exact_match']['availability']['selectable'] is True
    assert by_id['comet']['availability']['selectable'] is False
    assert 'metric_incompatible' in by_id['comet']['availability']['reasons']


def test_descriptor_aliases_cover_every_pinned_native_registry_key() -> None:
    catalogue = MetricCatalogue.load()
    covered = {
        metrics_module._normalize_alias(alias)
        for descriptor in catalogue._descriptors.values()
        for alias in (
            descriptor['id'],
            descriptor['registration']['key'],
            *descriptor['aliases'],
        )
    }
    assert {
        key
        for key in metrics_module._registered_metric_keys()
        if metrics_module._normalize_alias(key) not in covered
    } == set()


def test_explicit_selection_is_canonical_and_compiles_typed_parameters(catalogue) -> None:
    resolved = catalogue.resolve(
        {
            'mode': 'explicit',
            'metric_ids': ['Exact_Match', 'ANLS'],
            'primary_metric_id': 'Exact_Match',
            'parameters': {'ANLS': {'threshold': 0.7}},
        },
        'general_qa',
    )
    assert resolved is not None
    assert resolved.metric_ids == ('anls', 'exact_match')
    assert resolved.metric_list == ({'anls': {'thresh_hold': 0.7}}, 'exact_match')
    assert resolved.primary_metric_id == 'exact_match'
    assert resolved.primary_output_key == 'exact_match'
    assert resolved.provider_primary_output_key == 'mean_exact_match'
    assert resolved.output_metric_ids == {'anls': 'anls', 'exact_match': 'exact_match'}
    assert resolved.provider_output_bindings == {
        'mean_anls': ('anls', 'anls'),
        'mean_exact_match': ('exact_match', 'exact_match'),
    }
    assert resolved.scoring_config['metrics'][0]['parameters'] == {'threshold': 0.7}


def test_apply_strips_provider_selection_and_injects_only_compiled_fields(catalogue) -> None:
    payload, resolved = catalogue.apply(
        {
            'datasets': ['general_qa'],
            'metric_selection': {
                'mode': 'explicit',
                'metric_ids': ['exact_match'],
                'primary_metric_id': 'exact_match',
                'parameters': {},
            },
        },
        'general_qa',
    )
    assert resolved is not None
    assert 'metric_selection' not in payload
    assert payload['dataset_args']['general_qa'] == {
        'metric_list': ['exact_match'],
        'metric_failure_is_fatal': True,
        'primary_metric_id': 'exact_match',
        'primary_output_key': 'mean_exact_match',
    }


@pytest.mark.parametrize('score', [None, math.nan, math.inf])
def test_requested_metric_output_must_be_present_and_finite(catalogue, score) -> None:
    resolved = catalogue.resolve(
        {
            'mode': 'explicit',
            'metric_ids': ['exact_match'],
            'primary_metric_id': 'exact_match',
            'parameters': {},
        },
        'general_qa',
    )
    assert resolved is not None
    with pytest.raises(RuntimePolicyError) as raised:
        catalogue.assert_outputs(
            resolved,
            [{
                'dataset': 'general_qa',
                'subset': 'default',
                'metric': 'exact_match',
                'score': score,
                'sample_count': 1,
                'categories': [],
            }],
        )
    assert raised.value.code == 'metric_execution_failed'


def test_requested_outputs_are_bound_to_canonical_metric_identity(catalogue) -> None:
    resolved = catalogue.resolve(
        {
            'mode': 'explicit',
            'metric_ids': ['bleu'],
            'primary_metric_id': 'bleu',
            'parameters': {},
        },
        'general_qa',
    )
    assert resolved is not None
    bound = catalogue.bind_outputs(
        resolved,
        [
            {
                'dataset': 'general_qa',
                'subset': 'default',
                'metric': 'mean_bleu-4',
                'score': 0.75,
                'sample_count': 1,
                'categories': [],
            },
            {
                'dataset': 'general_qa',
                'subset': 'default',
                'metric': 'provider_internal',
                'score': 1,
                'sample_count': 1,
                'categories': [],
            },
        ],
    )
    assert len(bound) == 1
    assert bound[0]['metric'] == 'bleu-4'
    assert bound[0]['metric_id'] == 'bleu'
    assert bound[0]['output_key'] == 'bleu-4'


def test_missing_parent_module_is_reported_as_unavailable() -> None:
    assert metrics_module._module_available('definitely_missing_parent.child') is False
