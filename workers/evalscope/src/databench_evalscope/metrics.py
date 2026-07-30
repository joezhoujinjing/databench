"""Versioned Metric catalogue and Provider-owned selection compiler."""

from __future__ import annotations

import copy
import importlib
import importlib.util
import json
import math
import os
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any

from .config import EVALSCOPE_COMMIT
from .errors import RuntimePolicyError

_DIGEST = re.compile(r'^[0-9a-f]{64}$')
_METRIC_ID = re.compile(r'^[a-z][a-z0-9._-]{0,127}$')
_UPSTREAM_KEY = re.compile(r'^[A-Za-z][A-Za-z0-9._-]{0,127}$')
_FORBIDDEN_PARAMETER = re.compile(
    r'(?:^|_)(?:path|dir|directory|url|uri|endpoint|credential|secret|token|api_?key)(?:_|$)',
    re.IGNORECASE,
)
_MAX_SELECTED_METRICS = 16


@dataclass(frozen=True)
class ResolvedMetricSelection:
    benchmark: str
    metric_ids: tuple[str, ...]
    metric_list: tuple[str | dict[str, dict[str, Any]], ...]
    primary_metric_id: str
    primary_output_key: str
    provider_primary_output_key: str
    scoring_config: dict[str, Any]
    required_output_keys: tuple[str, ...]
    output_metric_ids: dict[str, str]
    provider_output_bindings: dict[str, tuple[str, str]]


class MetricCatalogue:
    """Loads the checked-in descriptor manifest and computes runtime readiness."""

    def __init__(self, descriptors: dict[str, dict[str, Any]]) -> None:
        self._descriptors = descriptors
        aliases: dict[str, str] = {}
        for metric_id, descriptor in descriptors.items():
            for alias in (metric_id, descriptor['registration']['key'], *descriptor['aliases']):
                normalized = _normalize_alias(alias)
                existing = aliases.get(normalized)
                if existing is not None and existing != metric_id:
                    raise RuntimeError(f'Metric alias {alias!r} is ambiguous')
                aliases[normalized] = metric_id
        self._aliases = aliases

    @classmethod
    def load(cls) -> 'MetricCatalogue':
        path = resources.files('databench_evalscope').joinpath('metric-descriptors.json')
        value = json.loads(path.read_text(encoding='utf-8'))
        return cls(_validate_manifest(value))

    def response(self, benchmark: str) -> dict[str, Any]:
        benchmark = _validate_benchmark(benchmark)
        registered_keys = _registered_metric_keys()
        return {
            'schema_version': 1,
            'evalscope_commit': EVALSCOPE_COMMIT,
            'benchmark': benchmark,
            'default_mode_available': True,
            'metrics': [
                self._public_descriptor(descriptor, benchmark, registered_keys)
                for descriptor in self._descriptors.values()
            ],
        }

    def resolve(
        self,
        value: Any,
        benchmark: str,
        *,
        enforce_availability: bool = True,
    ) -> ResolvedMetricSelection | None:
        benchmark = _validate_benchmark(benchmark)
        if not isinstance(value, dict):
            raise _selection_error('metric_selection must be an object', '/metric_selection')
        mode = value.get('mode')
        if mode == 'benchmark_default':
            if set(value) != {'mode'}:
                raise _selection_error(
                    'Benchmark default mode does not accept explicit Metric fields',
                    '/metric_selection',
                )
            return None
        if mode != 'explicit' or set(value) != {
            'mode',
            'metric_ids',
            'primary_metric_id',
            'parameters',
        }:
            raise _selection_error(
                'Explicit metric_selection must use the exact Provider schema',
                '/metric_selection',
            )
        raw_ids = value.get('metric_ids')
        if (
            not isinstance(raw_ids, list)
            or not raw_ids
            or len(raw_ids) > _MAX_SELECTED_METRICS
            or any(not isinstance(item, str) for item in raw_ids)
        ):
            raise _selection_error(
                f'Choose between 1 and {_MAX_SELECTED_METRICS} Metrics',
                '/metric_selection/metric_ids',
            )
        metric_ids = tuple(sorted(self._canonical_id(item) for item in raw_ids))
        if len(set(metric_ids)) != len(metric_ids):
            raise _selection_error(
                'Metric selection contains duplicate aliases',
                '/metric_selection/metric_ids',
            )
        raw_primary = value.get('primary_metric_id')
        if not isinstance(raw_primary, str):
            raise _selection_error('A primary Metric is required', '/metric_selection/primary_metric_id')
        primary_metric_id = self._canonical_id(raw_primary)
        if primary_metric_id not in metric_ids:
            raise _selection_error(
                'The primary Metric must be selected',
                '/metric_selection/primary_metric_id',
            )
        raw_parameters = value.get('parameters')
        if not isinstance(raw_parameters, dict):
            raise _selection_error('Metric parameters must be an object', '/metric_selection/parameters')
        canonical_parameter_ids: dict[str, Any] = {}
        for raw_id, parameters in raw_parameters.items():
            if not isinstance(raw_id, str):
                raise _selection_error('Metric parameter keys must be strings', '/metric_selection/parameters')
            metric_id = self._canonical_id(raw_id)
            if metric_id in canonical_parameter_ids:
                raise _selection_error(
                    'Metric parameters contain duplicate aliases',
                    '/metric_selection/parameters',
                )
            canonical_parameter_ids[metric_id] = parameters
        if not set(canonical_parameter_ids).issubset(metric_ids):
            raise _selection_error(
                'Parameters may only target selected Metrics',
                '/metric_selection/parameters',
            )

        registered_keys = _registered_metric_keys()
        compiled: list[str | dict[str, dict[str, Any]]] = []
        normalized_metrics: list[dict[str, Any]] = []
        output_owners: dict[str, str] = {}
        provider_output_bindings: dict[str, tuple[str, str]] = {}
        required_output_keys: list[str] = []
        for metric_id in metric_ids:
            descriptor = self._descriptors[metric_id]
            availability = _availability(descriptor, benchmark, registered_keys)
            if enforce_availability and not availability['selectable']:
                reason = availability['reasons'][0] if availability['reasons'] else 'metric_unavailable'
                raise RuntimePolicyError(
                    reason,
                    f'Metric {metric_id} is not selectable for Benchmark {benchmark}',
                    422,
                    '/metric_selection/metric_ids',
                )
            parameters = _normalize_parameters(
                descriptor,
                canonical_parameter_ids.get(metric_id, {}),
                f'/metric_selection/parameters/{metric_id}',
            )
            upstream_parameters = {
                descriptor['parameters'][key]['upstream_name']: parameter
                for key, parameter in parameters.items()
            }
            upstream_key = descriptor['registration']['key']
            compiled.append(
                upstream_key if not upstream_parameters else {upstream_key: upstream_parameters}
            )
            for output_key in descriptor['output_keys']:
                owner = output_owners.get(output_key)
                if owner is not None:
                    raise RuntimePolicyError(
                        'metric_output_conflict',
                        f'Metrics {owner} and {metric_id} both produce {output_key}',
                        422,
                        '/metric_selection/metric_ids',
                    )
                output_owners[output_key] = metric_id
                provider_output_key = _provider_output_key(output_key)
                if provider_output_key in provider_output_bindings:
                    raise RuntimePolicyError(
                        'metric_output_conflict',
                        f'Metrics produce the same Provider output {provider_output_key}',
                        422,
                        '/metric_selection/metric_ids',
                    )
                provider_output_bindings[provider_output_key] = (metric_id, output_key)
                required_output_keys.append(output_key)
            normalized_metrics.append({
                'id': metric_id,
                'implementation_digest': descriptor['implementation_digest'],
                'parameters': parameters,
                'output_keys': descriptor['output_keys'],
            })

        primary_descriptor = self._descriptors[primary_metric_id]
        primary_output_key = primary_descriptor['primary_output_key']
        if primary_output_key not in primary_descriptor['output_keys']:
            raise RuntimeError(f'Metric {primary_metric_id} has an invalid primary output')
        scoring_config = {
            'schema_version': 1,
            'mode': 'explicit',
            'evalscope_commit': EVALSCOPE_COMMIT,
            'benchmark': benchmark,
            'metrics': normalized_metrics,
            'primary_metric_id': primary_metric_id,
            'primary_output_key': primary_output_key,
        }
        return ResolvedMetricSelection(
            benchmark=benchmark,
            metric_ids=metric_ids,
            metric_list=tuple(compiled),
            primary_metric_id=primary_metric_id,
            primary_output_key=primary_output_key,
            provider_primary_output_key=_provider_output_key(primary_output_key),
            scoring_config=scoring_config,
            required_output_keys=tuple(required_output_keys),
            output_metric_ids=output_owners,
            provider_output_bindings=provider_output_bindings,
        )

    def apply(
        self,
        payload: dict[str, Any],
        benchmark: str,
        *,
        enforce_availability: bool = True,
    ) -> tuple[dict[str, Any], ResolvedMetricSelection | None]:
        prepared = copy.deepcopy(payload)
        raw_selection = prepared.pop('metric_selection', {'mode': 'benchmark_default'})
        resolved = self.resolve(
            raw_selection,
            benchmark,
            enforce_availability=enforce_availability,
        )
        if resolved is None:
            return prepared, None
        dataset_args = prepared.setdefault('dataset_args', {})
        if not isinstance(dataset_args, dict):
            raise _selection_error('dataset_args must be an object', '/dataset_args')
        benchmark_args = dataset_args.setdefault(benchmark, {})
        if not isinstance(benchmark_args, dict):
            raise _selection_error(
                'Benchmark dataset_args must be an object',
                f'/dataset_args/{benchmark}',
            )
        reserved = {
            'metric_list',
            'primary_metric_id',
            'primary_output_key',
            'metric_failure_is_fatal',
        }
        if reserved & set(benchmark_args):
            raise RuntimePolicyError(
                'metric_selection_conflict',
                'Metric configuration must only be submitted through metric_selection',
                422,
                f'/dataset_args/{benchmark}/metric_list',
            )
        benchmark_args.update({
            'metric_list': list(resolved.metric_list),
            'primary_metric_id': resolved.primary_metric_id,
            'primary_output_key': resolved.provider_primary_output_key,
            'metric_failure_is_fatal': True,
        })
        return prepared, resolved

    def assert_outputs(
        self,
        resolved: ResolvedMetricSelection,
        metrics: list[dict[str, Any]],
    ) -> None:
        scores_by_output: dict[str, list[float | None]] = {}
        for metric in metrics:
            output_key = metric.get('metric')
            if isinstance(output_key, str):
                scores_by_output.setdefault(output_key, []).append(metric.get('score'))
        missing = [
            output_key
            for output_key in resolved.required_output_keys
            if output_key not in scores_by_output
            or not scores_by_output[output_key]
            or any(
                isinstance(score, bool)
                or not isinstance(score, (int, float))
                or not math.isfinite(score)
                for score in scores_by_output[output_key]
            )
        ]
        if missing:
            raise RuntimePolicyError(
                'metric_execution_failed',
                f'EvalScope did not produce valid output for requested Metric: {missing[0]}',
                500,
                '/metric_selection',
            )

    def bind_outputs(
        self,
        resolved: ResolvedMetricSelection,
        metrics: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Keep requested outputs and attach identity without relying on report ordering."""
        bound: list[dict[str, Any]] = []
        for metric in metrics:
            provider_output_key = metric.get('metric')
            binding = (
                resolved.provider_output_bindings.get(provider_output_key)
                if isinstance(provider_output_key, str)
                else None
            )
            if binding is None:
                continue
            metric_id, output_key = binding
            bound.append({
                **metric,
                'metric': output_key,
                'metric_id': metric_id,
                'output_key': output_key,
            })
        return bound

    def _canonical_id(self, value: str) -> str:
        metric_id = self._aliases.get(_normalize_alias(value))
        if metric_id is None:
            raise RuntimePolicyError(
                'metric_unknown',
                'Metric is not present in the pinned Descriptor Catalog',
                422,
                '/metric_selection/metric_ids',
            )
        return metric_id

    @staticmethod
    def _public_descriptor(
        descriptor: dict[str, Any],
        benchmark: str,
        registered_keys: frozenset[str],
    ) -> dict[str, Any]:
        availability = _availability(descriptor, benchmark, registered_keys)
        return {
            'id': descriptor['id'],
            'label': descriptor['label'],
            'aliases': descriptor['aliases'],
            'input_contract': descriptor['input_contract'],
            'output_keys': descriptor['output_keys'],
            'primary_output_key': descriptor['primary_output_key'],
            'parameters': {
                name: {
                    key: value
                    for key, value in parameter.items()
                    if key != 'upstream_name'
                }
                for name, parameter in descriptor['parameters'].items()
            },
            'implementation': {
                'source': 'evalscope-native',
                'evalscope_commit': EVALSCOPE_COMMIT,
                'implementation_digest': descriptor['implementation_digest'],
            },
            'availability': availability,
        }


def _validate_manifest(value: Any) -> dict[str, dict[str, Any]]:
    if (
        not isinstance(value, dict)
        or set(value) != {'schema_version', 'evalscope_commit', 'metrics'}
        or value.get('schema_version') != 1
        or value.get('evalscope_commit') != EVALSCOPE_COMMIT
        or not isinstance(value.get('metrics'), list)
    ):
        raise RuntimeError('Metric Descriptor Manifest header is invalid')
    descriptors: dict[str, dict[str, Any]] = {}
    output = value['metrics']
    if not output:
        raise RuntimeError('Metric Descriptor Manifest must not be empty')
    required = {
        'id',
        'label',
        'aliases',
        'registration',
        'implementation_digest',
        'input_contract',
        'output_keys',
        'primary_output_key',
        'benchmarks',
        'parameters',
        'dependency_modules',
        'asset_env',
    }
    for descriptor in output:
        if not isinstance(descriptor, dict) or set(descriptor) != required:
            raise RuntimeError('Metric Descriptor fields are invalid')
        metric_id = descriptor.get('id')
        registration = descriptor.get('registration')
        if (
            not isinstance(metric_id, str)
            or not _METRIC_ID.fullmatch(metric_id)
            or metric_id in descriptors
            or not isinstance(descriptor.get('label'), str)
            or not descriptor['label']
            or not isinstance(registration, dict)
            or set(registration) != {'kind', 'key'}
            or registration.get('kind') not in {'adapter', 'registry'}
            or not isinstance(registration.get('key'), str)
            or not _UPSTREAM_KEY.fullmatch(registration['key'])
            or not isinstance(descriptor.get('implementation_digest'), str)
            or not _DIGEST.fullmatch(descriptor['implementation_digest'])
            or not isinstance(descriptor.get('aliases'), list)
            or any(not isinstance(alias, str) or not alias for alias in descriptor['aliases'])
            or not isinstance(descriptor.get('benchmarks'), list)
            or any(not isinstance(item, str) or not item for item in descriptor['benchmarks'])
            or not isinstance(descriptor.get('output_keys'), list)
            or not descriptor['output_keys']
            or any(not isinstance(item, str) or not item for item in descriptor['output_keys'])
            or len(set(descriptor['output_keys'])) != len(descriptor['output_keys'])
            or descriptor.get('primary_output_key') not in descriptor['output_keys']
            or not isinstance(descriptor.get('parameters'), dict)
            or not isinstance(descriptor.get('dependency_modules'), list)
            or any(not isinstance(item, str) or not item for item in descriptor['dependency_modules'])
            or (
                descriptor.get('asset_env') is not None
                and (
                    not isinstance(descriptor['asset_env'], str)
                    or not descriptor['asset_env'].startswith('EVALSCOPE_METRIC_')
                )
            )
        ):
            raise RuntimeError(f'Metric Descriptor {metric_id!r} is invalid')
        for name, parameter in descriptor['parameters'].items():
            if (
                not isinstance(name, str)
                or not _METRIC_ID.fullmatch(name)
                or _FORBIDDEN_PARAMETER.search(name)
                or not isinstance(parameter, dict)
                or parameter.get('type') not in {'boolean', 'number', 'string'}
                or not isinstance(parameter.get('upstream_name'), str)
                or _FORBIDDEN_PARAMETER.search(parameter['upstream_name'])
            ):
                raise RuntimeError(f'Metric parameter {metric_id}.{name} is invalid')
        descriptors[metric_id] = copy.deepcopy(descriptor)
    return descriptors


@lru_cache(maxsize=1)
def _registered_metric_keys() -> frozenset[str]:
    for module in (
        'evalscope.metrics.nlp.metrics',
        'evalscope.metrics.audio.metrics',
        'evalscope.metrics.vision.metrics',
    ):
        try:
            importlib.import_module(module)
        except (ImportError, ModuleNotFoundError, RuntimeError):
            continue
    from evalscope.api.registry import METRIC_REGISTRY

    return frozenset(METRIC_REGISTRY.keys())


def _availability(
    descriptor: dict[str, Any],
    benchmark: str,
    registered_keys: frozenset[str],
) -> dict[str, Any]:
    registration = descriptor['registration']
    registered = registration['kind'] == 'adapter' or registration['key'] in registered_keys
    compatible = benchmark in descriptor['benchmarks']
    dependency_ready = all(_module_available(module) for module in descriptor['dependency_modules'])
    asset_env = descriptor['asset_env']
    asset_ready = asset_env is None or _asset_ready(asset_env)
    reasons: list[str] = []
    if not registered:
        reasons.append('metric_not_registered')
    if not compatible:
        reasons.append('metric_incompatible')
    if not dependency_ready:
        reasons.append('metric_dependency_missing')
    if not asset_ready:
        reasons.append('metric_asset_missing')
    return {
        'registered': registered,
        'compatible': compatible,
        'dependency_ready': dependency_ready,
        'asset_ready': asset_ready,
        'selectable': not reasons,
        'reasons': reasons,
    }


def _asset_ready(environment_name: str) -> bool:
    value = os.getenv(environment_name)
    if value is None or not value.strip():
        return False
    if environment_name.endswith('_READY'):
        return value.strip().lower() in {'1', 'true', 'yes'}
    path = Path(value)
    return path.is_absolute() and path.exists()


def _module_available(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _normalize_parameters(
    descriptor: dict[str, Any],
    value: Any,
    field: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _selection_error('Metric parameters must be an object', field)
    specs = descriptor['parameters']
    if not set(value).issubset(specs):
        raise _selection_error('Metric parameters contain an unknown field', field)
    normalized: dict[str, Any] = {}
    for name, spec in specs.items():
        parameter = value.get(name, spec.get('default'))
        if parameter is None:
            continue
        parameter_type = spec['type']
        if parameter_type == 'number':
            if isinstance(parameter, bool) or not isinstance(parameter, (int, float)) or not math.isfinite(parameter):
                raise _selection_error(f'{name} must be a finite number', f'{field}/{name}')
            minimum = spec.get('minimum')
            maximum = spec.get('maximum')
            if (minimum is not None and parameter < minimum) or (
                maximum is not None and parameter > maximum
            ):
                raise _selection_error(f'{name} is outside its allowed range', f'{field}/{name}')
        elif parameter_type == 'boolean':
            if not isinstance(parameter, bool):
                raise _selection_error(f'{name} must be a boolean', f'{field}/{name}')
        elif (
            not isinstance(parameter, str)
            or len(parameter.encode('utf-8')) > 512
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in parameter)
        ):
            raise _selection_error(f'{name} must be a bounded string', f'{field}/{name}')
        choices = spec.get('choices')
        if choices is not None and parameter not in choices:
            raise _selection_error(f'{name} is not an allowed value', f'{field}/{name}')
        normalized[name] = parameter
    return normalized


def _normalize_alias(value: str) -> str:
    return unicodedata.normalize('NFKC', value).strip().casefold()


def _validate_benchmark(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value.encode('utf-8')) > 256
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        raise RuntimePolicyError(
            'benchmark_invalid',
            'Benchmark must be a bounded non-empty name',
            422,
            '/benchmark',
        )
    return value


def _provider_output_key(output_key: str) -> str:
    """Map a canonical sample output to EvalScope's fixed mean-aggregate report key."""
    return f'mean_{output_key}'


def _selection_error(message: str, field: str) -> RuntimePolicyError:
    return RuntimePolicyError('metric_selection_invalid', message, 422, field)
