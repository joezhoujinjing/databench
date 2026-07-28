#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOCK = REPOSITORY_ROOT / 'third_party/ms-swift/upstream.lock'
DEFAULT_CONFIG_OUTPUT = REPOSITORY_ROOT / 'third_party/ms-swift/gradio-baseline.json'
DEFAULT_ROUTES_OUTPUT = REPOSITORY_ROOT / 'third_party/ms-swift/gradio-routes.json'


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Generate the pinned ms-swift Gradio compatibility baseline.')
    parser.add_argument('upstream_root', type=Path)
    parser.add_argument('--lock', type=Path, default=DEFAULT_LOCK)
    parser.add_argument('--config-output', type=Path, default=DEFAULT_CONFIG_OUTPUT)
    parser.add_argument('--routes-output', type=Path, default=DEFAULT_ROUTES_OUTPUT)
    return parser.parse_args()


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def optional_property(props: dict[str, Any], name: str) -> Any:
    value = props.get(name)
    return value if isinstance(value, (bool, int, float, str)) or value is None else None


def normalize_component(component: dict[str, Any]) -> dict[str, Any]:
    props = component.get('props', {})
    normalized = {
        'id': component['id'],
        'type': component['type'],
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
        value = optional_property(props, name)
        if value is not None:
            normalized[name] = value
    return normalized


def normalize_dependency(dependency: dict[str, Any]) -> dict[str, Any]:
    return {
        'id': dependency['id'],
        'api_name': dependency.get('api_name'),
        'targets': dependency.get('targets', []),
        'inputs': dependency.get('inputs', []),
        'outputs': dependency.get('outputs', []),
        'backend_fn': bool(dependency.get('backend_fn', False)),
        'queue': bool(dependency.get('queue', False)),
        'connection': dependency.get('connection'),
        'generator': bool(dependency.get('types', {}).get('generator', False)),
        'cancel': bool(dependency.get('types', {}).get('cancel', False)),
        'trigger_after': dependency.get('trigger_after'),
        'trigger_mode': dependency.get('trigger_mode'),
    }


def route_classification(path: str, methods: list[str]) -> str:
    if 'WEBSOCKET' in methods or '/stream/' in path:
        return 'websocket-or-stream'
    if path in {'/', '/config', '/config/'}:
        return 'document-or-config'
    if path.startswith(('/assets/', '/static/', '/svelte/')) or path in {
        '/favicon.ico',
        '/manifest.json',
        '/pwa_icon',
        '/robots.txt',
        '/theme.css',
    }:
        return 'static-asset'
    if '/queue/' in path or path.endswith('/queue/status'):
        return 'queue'
    if 'upload' in path:
        return 'upload'
    if '/file' in path or '/proxy=' in path or 'playlist' in path:
        return 'file-or-download'
    if path.startswith('/monitoring'):
        return 'monitoring'
    if path.startswith(('/login', '/logout')) or '/login_check' in path or path.endswith('/user'):
        return 'auth-session'
    if 'vibe' in path or '/dev/' in path:
        return 'development'
    return 'gradio-api'


def collect_routes(app: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def visit(routes: list[Any]) -> None:
        for route in routes:
            original_router = getattr(route, 'original_router', None)
            if original_router is not None:
                visit(original_router.routes)
                continue
            path = getattr(route, 'path', None)
            if path:
                methods = sorted(getattr(route, 'methods', None) or [])
                if type(route).__name__ == 'APIWebSocketRoute':
                    methods = ['WEBSOCKET']
                rows.append({
                    'path': path,
                    'methods': methods,
                    'route_type': type(route).__name__,
                    'classification': route_classification(path, methods),
                    'proxy_required': True,
                })
            child_routes = getattr(route, 'routes', None)
            if child_routes:
                visit(child_routes)

    visit(app.routes)
    return sorted(rows, key=lambda row: (row['path'], row['methods'], row['route_type']))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f'{path.suffix}.partial')
    temporary.write_text(f'{json.dumps(value, ensure_ascii=False, indent=2)}\n', encoding='utf-8')
    temporary.replace(path)


def main() -> None:
    args = arguments()
    upstream_root = args.upstream_root.resolve()
    lock = json.loads(args.lock.read_text(encoding='utf-8'))
    actual_commit = subprocess.run(
        ['git', 'rev-parse', 'HEAD'],
        cwd=upstream_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual_commit != lock['commit']:
        raise RuntimeError(f'ms-swift commit mismatch: expected {lock["commit"]}, received {actual_commit}')

    sys.path.insert(0, str(upstream_root))
    with tempfile.TemporaryDirectory(prefix='databench-swift-baseline-') as cache_root:
        os.environ['MODELSCOPE_CACHE'] = cache_root
        os.environ['HF_HOME'] = cache_root
        os.environ['SWIFT_UI_LANG'] = 'zh'
        os.environ['WEBUI_SHARE'] = 'false'

        import gradio as gr  # noqa: PLC0415
        import swift  # noqa: PLC0415
        import torch  # noqa: PLC0415
        import transformers  # noqa: PLC0415
        from gradio.routes import App  # noqa: PLC0415
        from swift.arguments import WebUIArguments  # noqa: PLC0415
        from swift.ui.app import SwiftWebUI  # noqa: PLC0415

        swift_source = Path(swift.__file__).resolve()
        if upstream_root not in swift_source.parents:
            raise RuntimeError(f'imported swift outside the requested upstream root: {swift_source}')

        captured: dict[str, Any] = {}

        def capture_launch(blocks: Any, *_args: Any, **_kwargs: Any) -> Any:
            captured['config'] = blocks.config
            captured['routes'] = collect_routes(App.create_app(blocks))
            return blocks

        gr.Blocks.launch = capture_launch
        SwiftWebUI(WebUIArguments(server_name='127.0.0.1', server_port=7860, share=False, lang='zh')).run()

        config = captured['config']
        components = [normalize_component(component) for component in config['components']]
        dependencies = [normalize_dependency(dependency) for dependency in config['dependencies']]
        top_level_tab_ids = {
            'llm_train',
            'llm_rlhf',
            'llm_grpo',
            'llm_infer',
            'llm_export',
            'llm_eval',
            'llm_sample',
        }
        top_level_tabs = [
            component
            for component in components
            if component['type'] == 'tabitem' and component.get('elem_id') in top_level_tab_ids
        ]
        component_type_counts = dict(sorted(Counter(item['type'] for item in components).items()))
        api_names = sorted(
            dependency['api_name']
            for dependency in dependencies
            if isinstance(dependency['api_name'], str)
        )

        environment = {
            'python': '.'.join(map(str, sys.version_info[:3])),
            'ms_swift': swift.__version__,
            'gradio': gr.__version__,
            'torch': torch.__version__,
            'transformers': transformers.__version__,
        }
        expected_environment = lock['baseline_environment']
        for name, expected in expected_environment.items():
            if environment.get(name) != expected:
                raise RuntimeError(
                    f'baseline environment mismatch for {name}: expected {expected}, received {environment.get(name)}')

        baseline = {
            'schema_version': 1,
            'upstream_commit': lock['commit'],
            'environment': environment,
            'component_count': len(components),
            'dependency_count': len(dependencies),
            'component_type_counts': component_type_counts,
            'top_level_tabs': top_level_tabs,
            'api_names': api_names,
            'components_sha256': sha256(components),
            'dependencies_sha256': sha256(dependencies),
            'components': components,
            'dependencies': dependencies,
        }
        routes = captured['routes']
        route_manifest = {
            'schema_version': 1,
            'upstream_commit': lock['commit'],
            'gradio_version': gr.__version__,
            'root_path': '/swift-studio',
            'route_count': len(routes),
            'routes_sha256': sha256(routes),
            'routes': routes,
        }

        write_json(args.config_output, baseline)
        write_json(args.routes_output, route_manifest)
        print(
            f'wrote {len(components)} components, {len(dependencies)} dependencies, '
            f'and {len(routes)} routes for ms-swift {swift.__version__}')


if __name__ == '__main__':
    main()
