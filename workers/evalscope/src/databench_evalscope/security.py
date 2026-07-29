"""Request admission and server-side endpoint policy."""

from __future__ import annotations

import ipaddress
import re
import socket
import threading
from dataclasses import dataclass
from typing import Any, Callable, Iterable
from urllib.parse import SplitResult, urljoin, urlsplit, urlunsplit

from .errors import RuntimePolicyError

_TASK_ID = re.compile(r'^(?:eval|perf)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
_CAMEL_BOUNDARY = re.compile(r'([a-z0-9])([A-Z])')
_KEY_PARTS = re.compile(r'[^a-z0-9]+')
_URI_VALUE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*:')
_WINDOWS_DRIVE = re.compile(r'^[A-Za-z]:[\\/]')
_FORBIDDEN_LOCATOR_PARTS = {
    'path',
    'paths',
    'dir',
    'dirs',
    'directory',
    'directories',
    'folder',
    'folders',
    'file',
    'files',
    'filename',
    'url',
    'urls',
    'uri',
    'uris',
    'location',
    'locations',
    'endpoint',
    'endpoints',
    'host',
    'hostname',
    'address',
    'bucket',
    'objectkey',
    'storage',
    'repo',
    'repository',
    'hub',
}
_FORBIDDEN_LOCATOR_KEYS = {
    'dataid',
    'datasetid',
    'repoid',
    'localpath',
    'rootpath',
    'basepath',
    'sourcepath',
    'datafile',
}


def validate_task_id(value: str) -> str:
    if not isinstance(value, str) or not _TASK_ID.fullmatch(value):
        raise RuntimePolicyError(
            'invalid_task_id',
            'Task ID must use eval_<uuid> or perf_<uuid>',
            400,
            '/headers/EvalScope-Task-Id',
        )
    return value


def _pointer_token(value: str) -> str:
    return value.replace('~', '~0').replace('/', '~1')


def _key_parts(key: str) -> tuple[str, ...]:
    separated = _CAMEL_BOUNDARY.sub(r'\1_\2', key).lower()
    return tuple(part for part in _KEY_PARTS.split(separated) if part)


def _is_locator_key(key: str) -> bool:
    parts = _key_parts(key)
    compact = ''.join(parts)
    return compact in _FORBIDDEN_LOCATOR_KEYS or any(part in _FORBIDDEN_LOCATOR_PARTS for part in parts)


def _is_forbidden_locator_value(value: str) -> bool:
    stripped = value.strip()
    if not stripped:
        return False
    if stripped.startswith(('/', '\\', '~/')) or _WINDOWS_DRIVE.match(stripped):
        return True
    if stripped.startswith('//') or stripped.startswith('\\\\') or _URI_VALUE.match(stripped):
        return True
    return '..' in re.split(r'[\\/]+', stripped)


def validate_dataset_args(value: Any, *, max_nodes: int = 10_000, max_depth: int = 32) -> None:
    """Reject every native dataset locator before task claim creation."""

    if not isinstance(value, dict):
        raise RuntimePolicyError(
            'dataset_args_invalid',
            'dataset_args must be a JSON object',
            422,
            '/dataset_args',
        )

    nodes = 0

    def visit(node: Any, pointer: str, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes or depth > max_depth:
            raise RuntimePolicyError(
                'dataset_args_too_complex',
                'dataset_args exceeds the configured complexity bound',
                422,
                pointer or '/dataset_args',
            )
        if isinstance(node, dict):
            for key, child in node.items():
                child_pointer = f'{pointer}/{_pointer_token(str(key))}'
                if not isinstance(key, str) or _is_locator_key(key):
                    raise RuntimePolicyError(
                        'dataset_args_locator_forbidden',
                        'dataset_args cannot contain path, file, URL, URI, host, or repository locators',
                        422,
                        child_pointer,
                    )
                visit(child, child_pointer, depth + 1)
        elif isinstance(node, list):
            for index, child in enumerate(node):
                visit(child, f'{pointer}/{index}', depth + 1)
        elif isinstance(node, str) and _is_forbidden_locator_value(node):
            raise RuntimePolicyError(
                'dataset_args_locator_forbidden',
                'dataset_args cannot contain absolute, traversing, drive, UNC, or URI-like values',
                422,
                pointer or '/dataset_args',
            )
        elif node is not None and not isinstance(node, (str, bool, int, float)):
            raise RuntimePolicyError(
                'dataset_args_invalid',
                'dataset_args must contain JSON values only',
                422,
                pointer or '/dataset_args',
            )

    visit(value, '/dataset_args', 0)


@dataclass(frozen=True)
class EndpointRule:
    scheme: str
    host: str | None
    network: ipaddress.IPv4Network | ipaddress.IPv6Network | None
    port: int

    @classmethod
    def parse(cls, raw: str) -> 'EndpointRule':
        parts = raw.split('|')
        if len(parts) != 3:
            raise RuntimePolicyError(
                'invalid_runtime_config',
                'Endpoint allowlist entries must use scheme|host-or-cidr|port',
                500,
            )
        scheme, target, port_raw = (part.strip().lower() for part in parts)
        if scheme not in {'http', 'https'}:
            raise RuntimePolicyError('invalid_runtime_config', 'Endpoint rule scheme is invalid', 500)
        try:
            port = int(port_raw)
        except ValueError as exc:
            raise RuntimePolicyError('invalid_runtime_config', 'Endpoint rule port is invalid', 500) from exc
        if port < 1 or port > 65_535:
            raise RuntimePolicyError('invalid_runtime_config', 'Endpoint rule port is invalid', 500)
        try:
            network = ipaddress.ip_network(target, strict=False)
        except ValueError:
            if not target or '*' in target or '/' in target or target.endswith('.'):
                raise RuntimePolicyError('invalid_runtime_config', 'Endpoint rule host is invalid', 500)
            try:
                host = target.encode('idna').decode('ascii')
            except UnicodeError as exc:
                raise RuntimePolicyError('invalid_runtime_config', 'Endpoint rule host is invalid', 500) from exc
            return cls(scheme=scheme, host=host, network=None, port=port)
        return cls(scheme=scheme, host=None, network=network, port=port)


@dataclass(frozen=True)
class AuthorizedEndpoint:
    url: str
    hostname: str
    port: int
    addresses: tuple[str, ...]


Resolver = Callable[[str, int], Iterable[str]]


def _system_resolver(hostname: str, port: int) -> Iterable[str]:
    seen: set[str] = set()
    for item in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM):
        address = item[4][0]
        if address not in seen:
            seen.add(address)
            yield address


class EndpointPolicy:
    def __init__(self, rules: str, *, resolver: Resolver | None = None, redirect_max_hops: int = 0) -> None:
        self._rules = tuple(EndpointRule.parse(item) for item in rules.split(',') if item.strip())
        self._resolver = _system_resolver if resolver is None else resolver
        self._redirect_max_hops = redirect_max_hops

    def authorize_connection(self, raw_url: str) -> AuthorizedEndpoint:
        parsed = self._parse_url(raw_url)
        hostname = parsed.hostname or ''
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        matching_host = tuple(
            rule
            for rule in self._rules
            if rule.scheme == parsed.scheme and rule.port == port and rule.host == hostname
        )
        candidate_network_rules = tuple(
            rule
            for rule in self._rules
            if rule.scheme == parsed.scheme and rule.port == port and rule.network is not None
        )
        if not matching_host and not candidate_network_rules:
            raise RuntimePolicyError(
                'model_endpoint_host_rejected',
                'Model endpoint is not in the operator allowlist',
            )
        addresses = tuple(self._resolver(hostname, port))
        if not addresses:
            raise RuntimePolicyError('model_endpoint_dns_rejected', 'Model endpoint DNS resolution failed')
        normalized: list[str] = []
        for raw_address in addresses:
            try:
                address = ipaddress.ip_address(raw_address)
            except ValueError as exc:
                raise RuntimePolicyError(
                    'model_endpoint_dns_rejected',
                    'Model endpoint DNS returned an invalid address',
                ) from exc
            if address.is_unspecified or address.is_multicast or address.is_link_local or str(address) == '169.254.169.254':
                raise RuntimePolicyError(
                    'model_endpoint_address_rejected',
                    'Model endpoint resolved to a forbidden address class',
                )
            matching_network = tuple(rule for rule in candidate_network_rules if address in rule.network)
            if not address.is_global:
                if not matching_network:
                    raise RuntimePolicyError(
                        'model_endpoint_address_rejected',
                        'Private model endpoints require an explicit IP or CIDR rule',
                    )
            elif not matching_host and not matching_network:
                raise RuntimePolicyError(
                    'model_endpoint_host_rejected',
                    'Model endpoint is not in the operator allowlist',
                )
            normalized.append(address.compressed)
        return AuthorizedEndpoint(
            url=urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', '', '')),
            hostname=hostname,
            port=port,
            addresses=tuple(normalized),
        )

    def authorize_redirect(self, current_url: str, location: str, hop: int) -> AuthorizedEndpoint:
        if hop >= self._redirect_max_hops:
            raise RuntimePolicyError('model_endpoint_redirect_rejected', 'Model endpoint redirects are disabled')
        return self.authorize_connection(urljoin(current_url, location))

    @staticmethod
    def _parse_url(raw_url: str) -> SplitResult:
        try:
            parsed = urlsplit(raw_url)
            _ = parsed.port
        except ValueError as exc:
            raise RuntimePolicyError('model_endpoint_url_rejected', 'Model endpoint URL is invalid') from exc
        if (
            parsed.scheme not in {'http', 'https'}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or parsed.query
        ):
            raise RuntimePolicyError(
                'model_endpoint_url_rejected',
                'Model endpoint must be an HTTP(S) URL without userinfo, query, or fragment',
            )
        normalized_host = parsed.hostname.encode('idna').decode('ascii').lower()
        if normalized_host != parsed.hostname.lower():
            parsed = parsed._replace(netloc=f'{normalized_host}:{parsed.port}' if parsed.port else normalized_host)
        return parsed


_SOCKET_GUARD_LOCK = threading.Lock()
_SYSTEM_GETADDRINFO = socket.getaddrinfo


def install_socket_guard(rules: str) -> Callable[[], None]:
    """Revalidate every child-process DNS resolution against the endpoint allowlist.

    EvalScope task subprocesses perform the actual model connections.  This guard
    is installed inside the subprocess before the client is constructed so a
    redirect or DNS rebind cannot introduce an unreviewed destination.
    """

    original = _SYSTEM_GETADDRINFO

    def guarded(host: str | bytes | None, port: int | str | None, *args: Any, **kwargs: Any):
        if not isinstance(host, str) or isinstance(port, str) or not isinstance(port, int):
            raise OSError('Network destination is not an allowed HTTP endpoint')
        answers = original(host, port, *args, **kwargs)
        addresses = tuple(dict.fromkeys(item[4][0] for item in answers))
        policy = EndpointPolicy(
            rules,
            resolver=lambda candidate_host, candidate_port: (
                addresses if candidate_host.lower() == host.lower() and candidate_port == port else ()
            ),
            redirect_max_hops=0,
        )
        authorized: AuthorizedEndpoint | None = None
        for scheme in ('https', 'http'):
            try:
                authorized = policy.authorize_connection(f'{scheme}://{_url_host(host)}:{port}/')
                break
            except RuntimePolicyError:
                continue
        if authorized is None:
            raise OSError('Network destination is not in the operator allowlist')
        allowed_addresses = set(authorized.addresses)
        pinned = [
            item
            for item in answers
            if ipaddress.ip_address(item[4][0]).compressed in allowed_addresses
        ]
        if not pinned or len(pinned) != len(answers):
            raise OSError('Network destination changed during policy validation')
        return pinned

    with _SOCKET_GUARD_LOCK:
        if socket.getaddrinfo is not _SYSTEM_GETADDRINFO:
            raise RuntimePolicyError('network_guard_conflict', 'Socket policy is already installed', 500)
        socket.getaddrinfo = guarded

    def restore() -> None:
        with _SOCKET_GUARD_LOCK:
            if socket.getaddrinfo is guarded:
                socket.getaddrinfo = original

    return restore


def _url_host(hostname: str) -> str:
    return f'[{hostname}]' if ':' in hostname and not hostname.startswith('[') else hostname
