"""Read-only Provider API for the native Swift Studio process."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .config import (
    CAPABILITY_MANIFEST_SHA256,
    GRADIO_VERSION,
    MS_SWIFT_COMMIT,
    MS_SWIFT_VERSION,
    SWIFT_STUDIO_ROOT_PATH,
    TOP_LEVEL_SURFACES,
    RuntimeConfig,
)


@dataclass(frozen=True)
class ProbeResult:
    ready: bool
    detail: str


@dataclass(frozen=True)
class CapabilityManifest:
    manifest_id: str
    phase: str
    sha256: str
    component_count: int
    dependency_count: int
    components_sha256: str
    dependencies_sha256: str
    top_level_surfaces: tuple[str, ...]
    starting_capabilities: tuple[str, ...]
    ready_capabilities: tuple[str, ...]


Probe = Callable[[], ProbeResult]
GRADIO_CONFIG_MAX_BYTES = 8 * 1024 * 1024
CAPABILITY_MANIFEST_MAX_BYTES = 256 * 1024
CAPABILITY_MANIFEST_ID = 'swift-runtime-capabilities@1'
CAPABILITY_MANIFEST_PHASES = {'S1-in-progress', 'S1-complete'}
CAPABILITY_IDS_BY_SURFACE = {
    'llm_train': 'surface.train',
    'llm_rlhf': 'surface.rlhf',
    'llm_grpo': 'surface.grpo',
    'llm_infer': 'surface.infer',
    'llm_export': 'surface.export',
    'llm_eval': 'surface.eval',
    'llm_sample': 'surface.sample',
}
CAPABILITY_KEYS = {
    'id',
    'kind',
    'upstream_sources',
    'surface_present',
    'runtime_installed',
    'runtime_validated',
    'requirements',
    'evidence',
    'status',
    'known_limitations',
}


def _stable_sha256(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(',', ':'),
        ).encode('utf-8')
    ).hexdigest()


def _string_list(value: Any, name: str) -> tuple[str, ...]:
    if (
        not isinstance(value, list)
        or not value
        or any(not isinstance(item, str) or not item for item in value)
    ):
        raise ValueError(f'{name} must be a non-empty string array')
    return tuple(value)


def _sha256_value(value: Any, name: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in '0123456789abcdef' for character in value)
    ):
        raise ValueError(f'{name} must be a lowercase SHA-256 digest')
    return value


def _load_capability_manifest(path: Path) -> CapabilityManifest:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ValueError('Swift capability manifest cannot be read') from exc
    if len(raw) > CAPABILITY_MANIFEST_MAX_BYTES:
        raise ValueError('Swift capability manifest exceeds its byte boundary')
    manifest_sha256 = hashlib.sha256(raw).hexdigest()
    if manifest_sha256 != CAPABILITY_MANIFEST_SHA256:
        raise ValueError('Swift capability manifest does not match the image lock')
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError('Swift capability manifest is not valid JSON') from exc
    if not isinstance(payload, dict) or set(payload) != {
        'schema_version',
        'manifest_id',
        'upstream_commit',
        'phase',
        'compatibility',
        'provider_capabilities',
        'status_values',
        'capabilities',
    }:
        raise ValueError('Swift capability manifest has an unexpected top-level contract')
    if payload.get('schema_version') != 1 or payload.get('manifest_id') != CAPABILITY_MANIFEST_ID:
        raise ValueError('Swift capability manifest version does not match the Provider')
    if payload.get('upstream_commit') != MS_SWIFT_COMMIT:
        raise ValueError('Swift capability manifest commit does not match the Provider')
    phase = payload.get('phase')
    if phase not in CAPABILITY_MANIFEST_PHASES:
        raise ValueError('Swift capability manifest phase is not supported by the Provider')
    if payload.get('status_values') != ['planned', 'green']:
        raise ValueError('Swift capability manifest status values have drifted')

    compatibility = payload.get('compatibility')
    if not isinstance(compatibility, dict) or set(compatibility) != {
        'component_count',
        'dependency_count',
        'components_sha256',
        'dependencies_sha256',
        'top_level_surfaces',
    }:
        raise ValueError('Swift capability compatibility contract has drifted')
    component_count = compatibility.get('component_count')
    dependency_count = compatibility.get('dependency_count')
    if not isinstance(component_count, int) or isinstance(component_count, bool) or component_count <= 0:
        raise ValueError('Swift capability component count is invalid')
    if not isinstance(dependency_count, int) or isinstance(dependency_count, bool) or dependency_count <= 0:
        raise ValueError('Swift capability dependency count is invalid')
    top_level_surfaces = _string_list(
        compatibility.get('top_level_surfaces'),
        'Swift capability top-level surfaces',
    )
    if top_level_surfaces != TOP_LEVEL_SURFACES:
        raise ValueError('Swift capability top-level surfaces have drifted')

    provider_capabilities = payload.get('provider_capabilities')
    if not isinstance(provider_capabilities, dict) or set(provider_capabilities) != {
        'starting',
        'ready',
    }:
        raise ValueError('Swift Provider capability contract has drifted')
    starting_capabilities = _string_list(
        provider_capabilities.get('starting'),
        'Swift Provider starting capabilities',
    )
    ready_capabilities = _string_list(
        provider_capabilities.get('ready'),
        'Swift Provider ready capabilities',
    )
    if starting_capabilities != ('runtime-health',) or ready_capabilities != (
        'native-full-gradio',
        'runtime-health',
    ):
        raise ValueError('Swift Provider capability names have drifted')

    capability_rows = payload.get('capabilities')
    if not isinstance(capability_rows, list) or not capability_rows:
        raise ValueError('Swift capability manifest has no capabilities')
    capabilities: dict[str, dict[str, Any]] = {}
    for capability in capability_rows:
        if not isinstance(capability, dict) or set(capability) != CAPABILITY_KEYS:
            raise ValueError('Swift capability entry has an unexpected contract')
        capability_id = capability.get('id')
        if not isinstance(capability_id, str) or not capability_id or capability_id in capabilities:
            raise ValueError('Swift capability id is invalid or duplicated')
        for flag in ('surface_present', 'runtime_installed', 'runtime_validated'):
            if not isinstance(capability.get(flag), bool):
                raise ValueError(f'Swift capability {capability_id} has an invalid {flag}')
        if capability['runtime_validated'] and not capability['runtime_installed']:
            raise ValueError(f'Swift capability {capability_id} is validated but not installed')
        for field in ('upstream_sources', 'requirements', 'evidence', 'known_limitations'):
            value = capability.get(field)
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise ValueError(f'Swift capability {capability_id} has invalid {field}')
        if not capability['requirements'] or not capability['evidence']:
            raise ValueError(f'Swift capability {capability_id} lacks requirements or evidence')
        if capability.get('status') not in {'planned', 'green'}:
            raise ValueError(f'Swift capability {capability_id} has an invalid status')
        capabilities[capability_id] = capability

    shell = capabilities.get('surface.shell')
    root_path = capabilities.get('integration.root-path')
    if shell is None or not all(
        shell[flag] for flag in ('surface_present', 'runtime_installed', 'runtime_validated')
    ):
        raise ValueError('Swift native shell is not installed and validated')
    if root_path is None or not all(
        root_path[flag] for flag in ('surface_present', 'runtime_installed', 'runtime_validated')
    ):
        raise ValueError('Swift root-path integration is not installed and validated')
    for surface in top_level_surfaces:
        capability = capabilities.get(CAPABILITY_IDS_BY_SURFACE[surface])
        if capability is None or capability['surface_present'] is not True:
            raise ValueError(f'Swift capability manifest is missing native surface {surface}')

    return CapabilityManifest(
        manifest_id=CAPABILITY_MANIFEST_ID,
        phase=phase,
        sha256=manifest_sha256,
        component_count=component_count,
        dependency_count=dependency_count,
        components_sha256=_sha256_value(
            compatibility.get('components_sha256'),
            'Swift component graph digest',
        ),
        dependencies_sha256=_sha256_value(
            compatibility.get('dependencies_sha256'),
            'Swift dependency graph digest',
        ),
        top_level_surfaces=top_level_surfaces,
        starting_capabilities=starting_capabilities,
        ready_capabilities=ready_capabilities,
    )


def _normalize_component(component: dict[str, Any]) -> dict[str, Any]:
    component_id = component.get('id')
    component_type = component.get('type')
    if (
        not isinstance(component_id, int)
        or isinstance(component_id, bool)
        or not isinstance(component_type, str)
    ):
        raise ValueError('Gradio component graph contains an invalid component')
    props = component.get('props')
    if not isinstance(props, dict):
        props = {}
    normalized = {
        'id': component_id,
        'type': component_type,
        'skip_api': bool(component.get('skip_api', False)),
    }
    for name in (
        'elem_id',
        'label',
        'name',
        'visible',
        'interactive',
        'allow_custom_value',
        'multiselect',
        'open',
    ):
        value = props.get(name)
        if isinstance(value, (bool, int, float, str)):
            normalized[name] = value
    return normalized


def _normalize_dependency(dependency: dict[str, Any]) -> dict[str, Any]:
    dependency_id = dependency.get('id')
    if not isinstance(dependency_id, int) or isinstance(dependency_id, bool):
        raise ValueError('Gradio callback graph contains an invalid dependency')
    types = dependency.get('types')
    if not isinstance(types, dict):
        types = {}
    return {
        'id': dependency_id,
        'api_name': dependency.get('api_name'),
        'targets': dependency.get('targets', []),
        'inputs': dependency.get('inputs', []),
        'outputs': dependency.get('outputs', []),
        'backend_fn': bool(dependency.get('backend_fn', False)),
        'queue': bool(dependency.get('queue', False)),
        'connection': dependency.get('connection'),
        'generator': bool(types.get('generator', False)),
        'cancel': bool(types.get('cancel', False)),
        'trigger_after': dependency.get('trigger_after'),
        'trigger_mode': dependency.get('trigger_mode'),
    }


def _probe_gradio(config: RuntimeConfig, manifest: CapabilityManifest) -> ProbeResult:
    request = urllib.request.Request(
        config.local_gradio_config_url,
        headers={'Accept': 'application/json'},
        method='GET',
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            if response.status != 200:
                return ProbeResult(False, f'Gradio config returned HTTP {response.status}')
            if response.headers.get_content_type() != 'application/json':
                return ProbeResult(False, 'Gradio config returned an unexpected media type')
            payload = response.read(GRADIO_CONFIG_MAX_BYTES + 1)
    except (OSError, TimeoutError, urllib.error.URLError) as exc:
        return ProbeResult(False, f'Gradio is not ready: {type(exc).__name__}')
    if len(payload) > GRADIO_CONFIG_MAX_BYTES:
        return ProbeResult(False, 'Gradio config exceeded the Provider probe boundary')
    try:
        config_payload = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ProbeResult(False, 'Gradio config is not valid JSON')
    return _validate_gradio_config(config_payload, manifest)


def _validate_gradio_config(
    config_payload: Any,
    manifest: CapabilityManifest,
) -> ProbeResult:
    if not isinstance(config_payload, dict):
        return ProbeResult(False, 'Gradio config is not an object')
    components = config_payload.get('components')
    dependencies = config_payload.get('dependencies')
    if not isinstance(components, list):
        return ProbeResult(False, 'Gradio config has no component graph')
    if len(components) != manifest.component_count:
        return ProbeResult(False, 'Gradio component graph does not match the patched baseline')
    if not isinstance(dependencies, list):
        return ProbeResult(False, 'Gradio config has no callback graph')
    if len(dependencies) != manifest.dependency_count:
        return ProbeResult(False, 'Gradio callback graph does not match the locked baseline')
    if config_payload.get('version') != GRADIO_VERSION:
        return ProbeResult(False, 'Gradio version does not match the locked baseline')
    if config_payload.get('mode') != 'blocks' or config_payload.get('api_prefix') != '/gradio_api':
        return ProbeResult(False, 'Gradio runtime mode does not match the locked baseline')
    root = config_payload.get('root')
    if not isinstance(root, str) or urlparse(root).path.rstrip('/') != SWIFT_STUDIO_ROOT_PATH:
        return ProbeResult(False, 'Gradio root path does not match Databench')

    component_ids = {
        props.get('elem_id')
        for component in components
        if isinstance(component, dict)
        for props in [component.get('props')]
        if isinstance(props, dict)
    }
    missing_surfaces = set(manifest.top_level_surfaces) - component_ids
    if missing_surfaces:
        return ProbeResult(False, 'Gradio config is missing a native top-level surface')
    try:
        normalized_components = [
            _normalize_component(component)
            for component in components
            if isinstance(component, dict)
        ]
        normalized_dependencies = [
            _normalize_dependency(dependency)
            for dependency in dependencies
            if isinstance(dependency, dict)
        ]
    except ValueError as exc:
        return ProbeResult(False, str(exc))
    if len(normalized_components) != len(components):
        return ProbeResult(False, 'Gradio component graph contains an invalid component')
    if len(normalized_dependencies) != len(dependencies):
        return ProbeResult(False, 'Gradio callback graph contains an invalid dependency')
    if _stable_sha256(normalized_components) != manifest.components_sha256:
        return ProbeResult(False, 'Gradio component graph digest does not match the patched baseline')
    if _stable_sha256(normalized_dependencies) != manifest.dependencies_sha256:
        return ProbeResult(False, 'Gradio callback wiring does not match the patched baseline')
    return ProbeResult(True, 'ready')


def _version(distribution: str, fallback: str = 'unavailable') -> str:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return fallback


def _runtime_payload(
    config: RuntimeConfig,
    manifest: CapabilityManifest,
    native_gradio_ready: bool,
) -> dict[str, Any]:
    torch_version = _version('torch')
    cuda_version: str | None = None
    gpu_available = False
    try:
        import torch

        cuda_version = torch.version.cuda
        gpu_available = bool(torch.cuda.is_available())
    except Exception:
        pass
    return {
        'service': 'swift-studio-provider',
        'service_version': '0.1.0',
        'ms_swift_version': _version('ms-swift', MS_SWIFT_VERSION),
        'ms_swift_commit': MS_SWIFT_COMMIT,
        'gradio_version': _version('gradio', GRADIO_VERSION),
        'torch_version': torch_version,
        'cuda_version': cuda_version,
        'gpu_available': gpu_available,
        'root_path': config.root_path,
        'capability_manifest_id': manifest.manifest_id,
        'capability_manifest_phase': manifest.phase,
        'capability_manifest_sha256': manifest.sha256,
        'surfaces': list(manifest.top_level_surfaces) if native_gradio_ready else [],
        'capabilities': list(
            manifest.ready_capabilities
            if native_gradio_ready
            else manifest.starting_capabilities
        ),
    }


def create_app(
    config: RuntimeConfig | None = None,
    *,
    probe: Probe | None = None,
) -> FastAPI:
    runtime = RuntimeConfig.from_env() if config is None else config
    runtime.prepare()
    capability_manifest = _load_capability_manifest(runtime.capability_manifest_path)
    readiness_probe = probe or (lambda: _probe_gradio(runtime, capability_manifest))
    app = FastAPI(
        title='Databench Swift Studio Provider',
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware('http')
    async def private_response(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    @app.get('/health')
    async def health():
        result = await asyncio.to_thread(readiness_probe)
        payload = {
            'status': 'ok' if result.ready else 'starting',
            'service': 'swift-studio-provider',
            'ready': result.ready,
            'detail': result.detail,
            'ms_swift_commit': MS_SWIFT_COMMIT,
            'root_path': runtime.root_path,
            'capability_manifest_id': capability_manifest.manifest_id,
            'capability_manifest_phase': capability_manifest.phase,
            'capability_manifest_sha256': capability_manifest.sha256,
        }
        return JSONResponse(payload, status_code=200 if result.ready else 503)

    @app.get('/runtime')
    async def runtime_info():
        result = await asyncio.to_thread(readiness_probe)
        return {
            'ready': result.ready,
            **_runtime_payload(runtime, capability_manifest, result.ready),
        }

    return app
