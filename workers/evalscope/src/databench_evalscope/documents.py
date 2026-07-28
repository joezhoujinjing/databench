"""Sanitized generated documents and contained media access."""

from __future__ import annotations

import hashlib
import html
import json
import math
import mimetypes
import os
import re
import secrets
import stat
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable

import bleach
import html5lib

from .errors import RuntimePolicyError

_DOCUMENT_ID = re.compile(r'^[A-Za-z0-9_-]{43}$')
_HTML_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
_CREDENTIAL = re.compile(
    r'(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token|password|secret)\s*[:=]\s*\S+)',
    re.IGNORECASE,
)
_ABSOLUTE_PATH = re.compile(r'(?<![A-Za-z0-9])(?:/[A-Za-z0-9_.-]+){2,}')
_SIGNED_QUERY = re.compile(r'([?&](?:x-amz-|x-oss-|signature|token)[^\s"\']*)', re.IGNORECASE)
_SAFE_TAGS = {
    'a',
    'article',
    'aside',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'dd',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'li',
    'main',
    'ol',
    'p',
    'pre',
    'section',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
}
_MEDIA_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.mov': 'video/quicktime',
}


def sanitize_text(value: str) -> str:
    value = _CREDENTIAL.sub('[credential]', value)
    value = _SIGNED_QUERY.sub('[signed-query]', value)
    return _ABSOLUTE_PATH.sub('[path]', value)


def sanitize_json(value: Any, *, depth: int = 0, media_roots: tuple[Path, ...] = ()) -> Any:
    if depth > 64:
        raise RuntimePolicyError('upstream_response_invalid', 'Upstream response is too deeply nested', 502)
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, child in value.items():
            normalized = re.sub(r'[^a-z0-9]', '', str(key).lower())
            if any(token in normalized for token in ('apikey', 'authorization', 'password', 'secret', 'accesstoken')):
                continue
            result[str(key)] = sanitize_json(child, depth=depth + 1, media_roots=media_roots)
        return result
    if isinstance(value, list):
        return [sanitize_json(child, depth=depth + 1, media_roots=media_roots) for child in value]
    if isinstance(value, str):
        locator = media_locator(media_roots, value)
        if locator is not None:
            return locator
        return sanitize_text(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise RuntimePolicyError('upstream_response_invalid', 'Upstream response contains an invalid value', 502)


def _attribute_filter(tag: str, name: str, value: str) -> bool:
    if name not in {
        'href',
        'src',
        'title',
        'alt',
        'width',
        'height',
        'aria-label',
        'aria-describedby',
        'colspan',
        'rowspan',
        'id',
    }:
        return False
    if name == 'id':
        return bool(_HTML_ID.fullmatch(value))
    if name not in {'href', 'src'}:
        return True
    candidate = value.strip().lower()
    return candidate.startswith(('data:image/png;', 'data:image/jpeg;', '/evalscope-api/')) or (
        name == 'href' and candidate.startswith('#')
    )


def sanitize_active_html(raw: str) -> str:
    if len(raw.encode('utf-8')) > 16 * 1024 * 1024:
        raise RuntimePolicyError('generated_document_too_large', 'Generated document exceeds its bound', 413)
    cleaned = bleach.clean(
        _drop_active_elements(raw),
        tags=_SAFE_TAGS,
        attributes=_attribute_filter,
        protocols={'http', 'https', 'data'},
        strip=True,
        strip_comments=True,
    )
    return sanitize_text(cleaned)


def _drop_active_elements(raw: str) -> str:
    fragment = html5lib.parseFragment(raw, treebuilder='etree', namespaceHTMLElements=False)
    dangerous = {'script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math'}

    def prune(parent: Any) -> None:
        for child in list(parent):
            tag = child.tag.rsplit('}', 1)[-1].lower() if isinstance(child.tag, str) else ''
            if tag in dangerous:
                parent.remove(child)
            else:
                prune(child)

    prune(fragment)
    return html5lib.serialize(
        fragment,
        tree='etree',
        quote_attr_values='always',
        omit_optional_tags=False,
    )


@dataclass(frozen=True)
class PlotlySpec:
    element_id: str
    data: list[Any]
    layout: dict[str, Any]
    config: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            'element_id': self.element_id,
            'data': self.data,
            'layout': self.layout,
            'config': self.config,
        }


class _ScriptCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self._in_script = False
        self._parts: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == 'script':
            self._in_script = True
            self._parts = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == 'script' and self._in_script:
            self.scripts.append(''.join(self._parts))
            self._in_script = False

    def handle_data(self, data: str) -> None:
        if self._in_script:
            self._parts.append(data)


def extract_plotly_specs(raw: str) -> list[PlotlySpec]:
    """Parse only Plotly.newPlot JSON calls; all original scripts are discarded."""

    collector = _ScriptCollector()
    collector.feed(raw)
    specs: list[PlotlySpec] = []
    for script in collector.scripts:
        cursor = 0
        while True:
            start = script.find('Plotly.newPlot(', cursor)
            if start < 0:
                break
            arguments, cursor = _balanced_call(script, start + len('Plotly.newPlot('))
            values = _split_arguments(arguments)
            if len(values) not in {3, 4}:
                raise RuntimePolicyError('generated_document_invalid', 'Plotly chart arguments are invalid', 422)
            try:
                element_id = _json_load(values[0])
                data = _json_load(values[1])
                layout = _json_load(values[2])
                config = _json_load(values[3]) if len(values) == 4 else {}
            except (json.JSONDecodeError, ValueError) as exc:
                raise RuntimePolicyError(
                    'generated_document_invalid',
                    'Plotly chart contains non-JSON executable content',
                    422,
                ) from exc
            if isinstance(element_id, dict) and set(element_id) == {'id'}:
                element_id = element_id['id']
            if (
                not isinstance(element_id, str)
                or not _HTML_ID.fullmatch(element_id)
                or not isinstance(data, list)
                or not isinstance(layout, dict)
                or not isinstance(config, dict)
            ):
                raise RuntimePolicyError('generated_document_invalid', 'Plotly chart schema is invalid', 422)
            _validate_plotly_json(data)
            _validate_plotly_json(layout)
            _validate_plotly_json(config)
            config = dict(config)
            config['responsive'] = True
            config['displaylogo'] = False
            config.pop('plotlyServerURL', None)
            specs.append(PlotlySpec(element_id, data, layout, config))
            if len(specs) > 128:
                raise RuntimePolicyError('generated_document_invalid', 'Generated document has too many charts', 422)
    return specs


def _balanced_call(script: str, start: int) -> tuple[str, int]:
    depth = 1
    quote: str | None = None
    escaped = False
    for index in range(start, len(script)):
        character = script[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif character == '\\':
                escaped = True
            elif character == quote:
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character == '(':
            depth += 1
        elif character == ')':
            depth -= 1
            if depth == 0:
                return script[start:index], index + 1
    raise RuntimePolicyError('generated_document_invalid', 'Plotly chart call is unterminated', 422)


def _split_arguments(value: str) -> list[str]:
    result: list[str] = []
    start = 0
    stack: list[str] = []
    quote: str | None = None
    escaped = False
    pairs = {']': '[', '}': '{', ')': '('}
    for index, character in enumerate(value):
        if quote is not None:
            if escaped:
                escaped = False
            elif character == '\\':
                escaped = True
            elif character == quote:
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character in {'[', '{', '('}:
            stack.append(character)
        elif character in pairs:
            if not stack or stack.pop() != pairs[character]:
                raise RuntimePolicyError('generated_document_invalid', 'Plotly chart nesting is invalid', 422)
        elif character == ',' and not stack:
            result.append(value[start:index].strip())
            start = index + 1
    if quote is not None or stack:
        raise RuntimePolicyError('generated_document_invalid', 'Plotly chart nesting is invalid', 422)
    result.append(value[start:].strip())
    return result


def _json_load(value: str) -> Any:
    def reject_constant(_: str) -> None:
        raise ValueError('non-finite number')

    return json.loads(value, parse_constant=reject_constant)


def _json_script(value: Any) -> str:
    return (
        json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        .replace('<', '\\u003c')
        .replace('>', '\\u003e')
        .replace('&', '\\u0026')
        .replace('\u2028', '\\u2028')
        .replace('\u2029', '\\u2029')
    )


def _validate_plotly_json(value: Any) -> None:
    nodes = 0

    def visit(node: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > 200_000 or depth > 64:
            raise RuntimePolicyError('generated_document_invalid', 'Plotly chart is too complex', 422)
        if isinstance(node, dict):
            for key, child in node.items():
                if not isinstance(key, str) or len(key) > 256:
                    raise RuntimePolicyError('generated_document_invalid', 'Plotly chart key is invalid', 422)
                visit(child, depth + 1)
        elif isinstance(node, list):
            for child in node:
                visit(child, depth + 1)
        elif isinstance(node, str):
            candidate = node.strip().lower()
            if candidate.startswith(('http:', 'https:', '//', 'file:', 'ftp:', 'data:')):
                raise RuntimePolicyError(
                    'generated_document_invalid',
                    'Plotly chart cannot contain external resource locators',
                    422,
                )
        elif node is not None and not isinstance(node, (bool, int, float)):
            raise RuntimePolicyError('generated_document_invalid', 'Plotly chart value is invalid', 422)

    visit(value, 0)


@dataclass(frozen=True)
class GeneratedDocumentDescriptor:
    document_id: str
    document_url: str
    expires_at: int
    kind: str

    def to_dict(self) -> dict[str, Any]:
        return {
            'document_id': self.document_id,
            'document_url': self.document_url,
            'expires_at': self.expires_at,
            'kind': self.kind,
        }


class GeneratedDocumentStore:
    def __init__(
        self,
        root: Path,
        *,
        ttl_seconds: int,
        max_bytes: int,
        plotly_digest: str,
        databench_origin: str,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._root = root / '.generated-documents'
        self._root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._ttl_seconds = ttl_seconds
        self._max_bytes = max_bytes
        self._plotly_digest = plotly_digest
        self._origin = databench_origin
        self._now = time.time if now is None else now

    def create(self, raw_html: str, *, kind: str) -> GeneratedDocumentDescriptor:
        safe_body = sanitize_active_html(raw_html)
        plotly_specs = [spec.to_dict() for spec in extract_plotly_specs(raw_html)]
        expires_at = int(self._now()) + self._ttl_seconds
        document_id = secrets.token_urlsafe(32)
        if not _DOCUMENT_ID.fullmatch(document_id):
            raise RuntimePolicyError('generated_document_invalid', 'Generated document ID failed', 500)
        payload = {
            'schema_version': 2,
            'expires_at': expires_at,
            'kind': kind,
            'body': safe_body,
            'plotly_specs': plotly_specs,
        }
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(raw) > self._max_bytes:
            raise RuntimePolicyError('generated_document_too_large', 'Generated document exceeds its bound', 413)
        path = self._root / f'{document_id}.json'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            offset = 0
            while offset < len(raw):
                offset += os.write(fd, raw[offset:])
            os.fsync(fd)
        finally:
            os.close(fd)
        directory = os.open(self._root, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return GeneratedDocumentDescriptor(
            document_id=document_id,
            document_url=f'/evalscope-api/generated-documents/{document_id}',
            expires_at=expires_at,
            kind=kind,
        )

    def read(self, document_id: str) -> tuple[bytes, dict[str, str]]:
        if not _DOCUMENT_ID.fullmatch(document_id):
            raise RuntimePolicyError('generated_document_not_found', 'Generated document was not found', 404)
        path = self._root / f'{document_id}.json'
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        except FileNotFoundError as exc:
            raise RuntimePolicyError('generated_document_not_found', 'Generated document was not found', 404) from exc
        except OSError as exc:
            raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500) from exc
        try:
            metadata = os.fstat(fd)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_nlink != 1
                or metadata.st_size <= 0
                or metadata.st_size > self._max_bytes
            ):
                raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500)
            raw = os.read(fd, self._max_bytes + 1)
            if len(raw) != metadata.st_size:
                raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500)
        finally:
            os.close(fd)
        if not raw or len(raw) > self._max_bytes:
            raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500)
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500) from exc
        if (
            not isinstance(payload, dict)
            or set(payload) != {'schema_version', 'expires_at', 'kind', 'body', 'plotly_specs'}
            or payload.get('schema_version') != 2
            or not isinstance(payload.get('expires_at'), int)
            or not isinstance(payload.get('kind'), str)
            or not isinstance(payload.get('body'), str)
            or not isinstance(payload.get('plotly_specs'), list)
        ):
            raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500)
        if payload['expires_at'] <= int(self._now()):
            path.unlink(missing_ok=True)
            raise RuntimePolicyError('generated_document_expired', 'Generated document has expired', 410)
        nonce = secrets.token_urlsafe(24)
        specs = self._validate_stored_specs(payload['plotly_specs'])
        document = self._render(payload['body'], specs, nonce)
        headers = {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': self._csp(nonce),
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'private, no-store',
            'X-Frame-Options': 'SAMEORIGIN',
        }
        return document, headers

    def _render(self, body: str, specs: list[PlotlySpec], nonce: str) -> bytes:
        safe_nonce = html.escape(nonce, quote=True)
        style = (
            'body{margin:0;padding:24px;background:#0b1020;color:#e5e7eb;font:14px/1.55 system-ui,sans-serif}'
            'table{border-collapse:collapse;width:100%}th,td{border:1px solid #334155;padding:8px;text-align:left}'
            'a{color:#8ab4ff}pre{white-space:pre-wrap;overflow-wrap:anywhere}'
        )
        scripts = ''
        if specs:
            asset = f'/evalscope-api/generated-assets/plotly-{self._plotly_digest}.min.js'
            bootstrap = (
                f'<script nonce="{safe_nonce}">(function(){{'
                'const createElement=document.createElement.bind(document);'
                'document.createElement=function(name,options){'
                'const element=createElement(name,options);'
                f'if(String(name).toLowerCase()==="style"){{element.setAttribute("nonce",{_json_script(nonce)});}}'
                'return element;};})();</script>'
            )
            scripts = bootstrap + f'<script nonce="{safe_nonce}" src="{asset}"></script>'
            calls: list[str] = []
            for spec in specs:
                calls.append(
                    'Plotly.newPlot(document.getElementById('
                    f'{_json_script(spec.element_id)}),{_json_script(spec.data)},'
                    f'{_json_script(spec.layout)},{_json_script(spec.config)});'
                )
            scripts += f'<script nonce="{safe_nonce}">{"".join(calls)}</script>'
        return (
            '<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="referrer" content="no-referrer">'
            f'<style nonce="{safe_nonce}">{style}</style>'
            f'</head><body>{body}{scripts}</body></html>'
        ).encode('utf-8')

    def _csp(self, nonce: str) -> str:
        asset = f"{self._origin}/evalscope-api/generated-assets/plotly-{self._plotly_digest}.min.js"
        return (
            "sandbox allow-scripts; default-src 'none'; "
            f"script-src 'nonce-{nonce}' {asset}; style-src 'nonce-{nonce}'; "
            f"img-src data: blob: {self._origin}; media-src blob: {self._origin}; "
            f"font-src data: {self._origin}; connect-src 'none'; object-src 'none'; "
            "frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; "
            f'frame-ancestors {self._origin}'
        )

    @staticmethod
    def _validate_stored_specs(value: list[Any]) -> list[PlotlySpec]:
        result: list[PlotlySpec] = []
        if len(value) > 128:
            raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500)
        for item in value:
            if not isinstance(item, dict) or set(item) != {'element_id', 'data', 'layout', 'config'}:
                raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500)
            element_id = item.get('element_id')
            if (
                not isinstance(element_id, str)
                or not _HTML_ID.fullmatch(element_id)
                or not isinstance(item.get('data'), list)
                or not isinstance(item.get('layout'), dict)
                or not isinstance(item.get('config'), dict)
            ):
                raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500)
            try:
                _validate_plotly_json(item['data'])
                _validate_plotly_json(item['layout'])
                _validate_plotly_json(item['config'])
            except RuntimePolicyError as exc:
                raise RuntimePolicyError('generated_document_invalid', 'Generated document is invalid', 500) from exc
            config = dict(item['config'])
            config['responsive'] = True
            config['displaylogo'] = False
            config.pop('plotlyServerURL', None)
            result.append(PlotlySpec(element_id, item['data'], item['layout'], config))
        return result


def resolve_media(roots: tuple[Path, ...], locator: str) -> tuple[Path, str]:
    if not locator or len(locator.encode('utf-8')) > 2_048:
        raise RuntimePolicyError('media_locator_invalid', 'Media locator is invalid', 422)
    match = re.fullmatch(r'r([0-9]{1,3})/(.+)', locator)
    if match is None:
        raise RuntimePolicyError('media_locator_invalid', 'Media locator is invalid', 422)
    root_index = int(match.group(1))
    if root_index >= len(roots):
        raise RuntimePolicyError('media_locator_invalid', 'Media locator is invalid', 422)
    path = Path(match.group(2))
    if path.is_absolute() or '..' in path.parts or '\\' in locator or '\x00' in locator:
        raise RuntimePolicyError('media_locator_invalid', 'Media locator must be a contained relative path', 422)
    root = roots[root_index]
    candidate = (root / path).resolve(strict=False)
    if root not in candidate.parents or not candidate.is_file() or candidate.is_symlink():
        raise RuntimePolicyError('media_not_found', 'Media file was not found', 404)
    extension = candidate.suffix.lower()
    expected = _MEDIA_TYPES.get(extension)
    guessed, _ = mimetypes.guess_type(candidate.name)
    if expected is None or guessed != expected or not _media_signature_matches(candidate, extension):
        raise RuntimePolicyError('media_type_forbidden', 'Media type is not allowed inline', 403)
    return candidate, expected


def media_locator(roots: tuple[Path, ...], value: str) -> str | None:
    if not value.startswith('/') or len(value.encode('utf-8')) > 4096 or '\x00' in value:
        return None
    try:
        candidate = Path(value).resolve(strict=False)
    except (OSError, RuntimeError):
        return None
    for index, root in enumerate(roots):
        if root not in candidate.parents or not candidate.is_file() or candidate.is_symlink():
            continue
        relative = candidate.relative_to(root).as_posix()
        return f'r{index}/{relative}'
    return None


def _media_signature_matches(path: Path, extension: str) -> bool:
    with path.open('rb') as stream:
        head = stream.read(64)
    checks = {
        '.png': lambda: head.startswith(b'\x89PNG\r\n\x1a\n'),
        '.jpg': lambda: head.startswith(b'\xff\xd8\xff'),
        '.jpeg': lambda: head.startswith(b'\xff\xd8\xff'),
        '.gif': lambda: head.startswith((b'GIF87a', b'GIF89a')),
        '.webp': lambda: head.startswith(b'RIFF') and head[8:12] == b'WEBP',
        '.bmp': lambda: head.startswith(b'BM'),
        '.mp3': lambda: head.startswith(b'ID3') or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0),
        '.wav': lambda: head.startswith(b'RIFF') and head[8:12] == b'WAVE',
        '.flac': lambda: head.startswith(b'fLaC'),
        '.aac': lambda: len(head) >= 2 and head[0] == 0xFF and head[1] & 0xF6 == 0xF0,
        '.m4a': lambda: len(head) >= 12 and head[4:8] == b'ftyp',
        '.opus': lambda: head.startswith(b'OggS') and b'OpusHead' in head,
        '.mp4': lambda: len(head) >= 12 and head[4:8] == b'ftyp',
        '.webm': lambda: head.startswith(b'\x1aE\xdf\xa3'),
        '.ogg': lambda: head.startswith(b'OggS'),
        '.mov': lambda: len(head) >= 12 and head[4:8] == b'ftyp',
    }
    check = checks.get(extension)
    return check is not None and check()
