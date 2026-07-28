from __future__ import annotations

from pathlib import Path

import pytest

from databench_evalscope.documents import (
    GeneratedDocumentStore,
    media_locator,
    resolve_media,
    sanitize_active_html,
    sanitize_json,
)
from databench_evalscope.errors import RuntimePolicyError

PLOTLY_DIGEST = '6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603'


def test_malicious_html_is_sanitized_and_plotly_is_rebuilt_from_json(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = GeneratedDocumentStore(
        root,
        ttl_seconds=60,
        max_bytes=1024 * 1024,
        plotly_digest=PLOTLY_DIGEST,
        databench_origin='https://databench.example',
        now=lambda: 100,
    )
    raw = '''
      <div id="plot"></div>
      <img src="https://evil.example/pixel" onerror="alert(1)">
      <script src="https://evil.example/malware.js"></script>
      <script>Plotly.newPlot("plot", [{"x":[1],"y":[2]}], {"title":"safe"}, {});alert(1)</script>
      <iframe src="https://evil.example"></iframe>
    '''
    descriptor = store.create(raw, kind='evaluation-chart')
    document, headers = store.read(descriptor.document_id)
    text = document.decode()
    assert descriptor.document_url.startswith('/evalscope-api/generated-documents/')
    assert 'evil.example' not in text
    assert 'onerror' not in text
    assert '<iframe' not in text
    assert 'alert(1)' not in text
    assert f'plotly-{PLOTLY_DIGEST}.min.js' in text
    assert 'Plotly.newPlot(document.getElementById("plot")' in text
    assert '"displaylogo":false' in text
    assert 'document.createElement=function(name,options)' in text
    assert text.index('document.createElement=function(name,options)') < text.index(
        f'plotly-{PLOTLY_DIGEST}.min.js'
    )
    assert "unsafe-inline" not in headers['Content-Security-Policy']
    assert "unsafe-eval" not in headers['Content-Security-Policy']
    assert "connect-src 'none'" in headers['Content-Security-Policy']
    assert headers['X-Content-Type-Options'] == 'nosniff'


def test_generated_document_accepts_plotly_uuid_id_starting_with_digit(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = GeneratedDocumentStore(
        root,
        ttl_seconds=60,
        max_bytes=1024 * 1024,
        plotly_digest=PLOTLY_DIGEST,
        databench_origin='https://databench.example',
    )
    chart_id = '81913de5-158a-4039-9b92-5d79c2979310'
    descriptor = store.create(
        f'<div id="{chart_id}"></div>'
        f'<script>Plotly.newPlot("{chart_id}", [{{"x":[1],"y":[2]}}], {{}}, {{}})</script>',
        kind='evaluation-report',
    )

    document, _ = store.read(descriptor.document_id)
    assert f'Plotly.newPlot(document.getElementById("{chart_id}")' in document.decode('utf-8')


def test_plotly_executable_arguments_and_external_resources_are_rejected(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    store = GeneratedDocumentStore(
        root,
        ttl_seconds=60,
        max_bytes=1024 * 1024,
        plotly_digest=PLOTLY_DIGEST,
        databench_origin='https://databench.example',
    )
    with pytest.raises(RuntimePolicyError):
        store.create('<script>Plotly.newPlot("p", window.payload, {}, {})</script>', kind='chart')
    with pytest.raises(RuntimePolicyError):
        store.create(
            '<script>Plotly.newPlot("p", [], {"images":[{"source":"https://evil.example/x"}]}, {})</script>',
            kind='chart',
        )


def test_generated_document_expiry_is_enforced(tmp_path: Path) -> None:
    now = [100.0]
    root = tmp_path / 'outputs'
    root.mkdir()
    store = GeneratedDocumentStore(
        root,
        ttl_seconds=1,
        max_bytes=1024 * 1024,
        plotly_digest=PLOTLY_DIGEST,
        databench_origin='https://databench.example',
        now=lambda: now[0],
    )
    descriptor = store.create('<p>safe</p>', kind='report')
    now[0] = 102
    with pytest.raises(RuntimePolicyError) as captured:
        store.read(descriptor.document_id)
    assert captured.value.code == 'generated_document_expired'


def test_media_locators_are_root_scoped_and_signature_checked(tmp_path: Path) -> None:
    output = tmp_path / 'outputs'
    inputs = tmp_path / 'inputs'
    output.mkdir()
    inputs.mkdir()
    image = output / 'task' / 'image.png'
    image.parent.mkdir()
    image.write_bytes(b'\x89PNG\r\n\x1a\n' + b'0' * 32)
    locator = media_locator((output, inputs), str(image))
    assert locator == 'r0/task/image.png'
    assert resolve_media((output, inputs), locator or '') == (image, 'image/png')
    with pytest.raises(RuntimePolicyError):
        resolve_media((output, inputs), 'r0/../secret.png')

    disguised = output / 'bad.png'
    disguised.write_text('<script>alert(1)</script>')
    with pytest.raises(RuntimePolicyError) as captured:
        resolve_media((output, inputs), 'r0/bad.png')
    assert captured.value.code == 'media_type_forbidden'


def test_json_sanitizer_removes_credentials_paths_and_maps_media(tmp_path: Path) -> None:
    root = tmp_path / 'outputs'
    root.mkdir()
    image = root / 'image.png'
    image.write_bytes(b'\x89PNG\r\n\x1a\n' + b'0' * 32)
    value = sanitize_json(
        {
            'api_key': 'secret',
            'message': 'authorization=Bearer-secret /var/lib/evalscope/private/file',
            'media': str(image),
        },
        media_roots=(root,),
    )
    assert 'api_key' not in value
    assert value['message'] == '[credential] [path]'
    assert value['media'] == 'r0/image.png'


def test_json_sanitizer_normalizes_non_finite_numbers() -> None:
    value = sanitize_json({'nan': float('nan'), 'positive': float('inf'), 'negative': -float('inf')})
    assert value == {'nan': None, 'positive': None, 'negative': None}


def test_html_sanitizer_never_keeps_remote_images() -> None:
    sanitized = sanitize_active_html(
        '<img src="https://evil.example/x"><a href="javascript:alert(1)">x</a>'
        '<a href="https://evil.example/navigate">remote</a><a href="#section">local</a>'
    )
    assert 'evil.example' not in sanitized
    assert 'javascript:' not in sanitized
    assert 'href="#section"' in sanitized
