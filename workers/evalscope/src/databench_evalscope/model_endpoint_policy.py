"""Versioned default-deny Model endpoint policy and pinned socket transport."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import SplitResult, urlsplit, urlunsplit

from .errors import RuntimePolicyError

_DNS_LABEL = re.compile(r'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$')
_MAX_POLICY_BYTES = 256 * 1024
_SYSTEM_GETADDRINFO = socket.getaddrinfo
_SOCKET_GUARD_LOCK = threading.Lock()


@dataclass(frozen=True)
class PrivateEndpointRuleV1:
    hostname: str
    cidrs: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]
    schemes: tuple[str, ...]
    ports: tuple[int, ...]


@dataclass(frozen=True)
class PublicEndpointRuleV1:
    hostname: str
    ports: tuple[int, ...]


@dataclass(frozen=True)
class ModelEndpointPolicyConfigV1:
    profile: str
    generation: int
    private_network: tuple[PrivateEndpointRuleV1, ...]
    public_network: tuple[PublicEndpointRuleV1, ...]

    @classmethod
    def parse(cls, value: Any) -> 'ModelEndpointPolicyConfigV1':
        if not isinstance(value, dict) or set(value) != {
            'profile', 'generation', 'private_network', 'public_network'
        }:
            raise _invalid_config()
        generation = value.get('generation')
        if (
            value.get('profile') != 'model-endpoint-policy-v1'
            or isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation < 1
            or generation > 9_007_199_254_740_991
        ):
            raise _invalid_config()
        private_raw = value.get('private_network')
        public_raw = value.get('public_network')
        if (
            not isinstance(private_raw, list)
            or len(private_raw) > 256
            or not isinstance(public_raw, list)
            or len(public_raw) > 256
        ):
            raise _invalid_config()
        return cls(
            profile='model-endpoint-policy-v1',
            generation=generation,
            private_network=tuple(_parse_private_rule(rule) for rule in private_raw),
            public_network=tuple(_parse_public_rule(rule) for rule in public_raw),
        )

    @classmethod
    def load(cls, path: Path) -> 'ModelEndpointPolicyConfigV1':
        if not path.is_absolute():
            raise _invalid_config()
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        except OSError as exc:
            raise _invalid_config() from exc
        try:
            stat = os.fstat(descriptor)
            if stat.st_size <= 0 or stat.st_size > _MAX_POLICY_BYTES:
                raise _invalid_config()
            raw = os.read(descriptor, stat.st_size + 1)
        finally:
            os.close(descriptor)
        try:
            value = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _invalid_config() from exc
        return cls.parse(value)

    @classmethod
    def deny_all(cls) -> 'ModelEndpointPolicyConfigV1':
        return cls(
            profile='model-endpoint-policy-v1',
            generation=1,
            private_network=(),
            public_network=(),
        )


@dataclass(frozen=True)
class AuthorizedEndpointV1:
    url: str
    hostname: str
    port: int
    addresses: tuple[str, ...]
    policy_generation: int
    scope: str


Resolver = Callable[[str, int], Iterable[str]]


def _system_resolver(hostname: str, port: int) -> Iterable[str]:
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        yield literal.compressed
        return
    seen: set[str] = set()
    for item in _SYSTEM_GETADDRINFO(hostname, port, type=socket.SOCK_STREAM):
        address = item[4][0]
        if address not in seen:
            seen.add(address)
            yield address


class ModelEndpointPolicyV1:
    def __init__(
        self,
        config: ModelEndpointPolicyConfigV1 | Mapping[str, Any],
        *,
        resolver: Resolver | None = None,
        release_profile: str = 'offline',
    ) -> None:
        if isinstance(config, ModelEndpointPolicyConfigV1):
            self._config = config
        else:
            self._config = ModelEndpointPolicyConfigV1.parse(config)
        if release_profile not in {'offline', 'connected'}:
            raise _invalid_config()
        self._resolver = _system_resolver if resolver is None else resolver
        self._release_profile = release_profile

    @property
    def generation(self) -> int:
        return self._config.generation

    def authorize_connection(self, raw_url: str, scope: str = 'private_network') -> AuthorizedEndpointV1:
        parsed = _parse_url(raw_url)
        hostname = parsed.hostname or ''
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        if scope == 'public_network' and self._release_profile != 'connected':
            raise RuntimePolicyError(
                'model_endpoint_public_network_disabled',
                'Public-network model endpoints are unavailable in the offline release profile',
            )
        if scope == 'private_network':
            private_rules = tuple(
                rule for rule in self._config.private_network
                if rule.hostname == hostname
                and parsed.scheme in rule.schemes
                and port in rule.ports
            )
            public_rules: tuple[PublicEndpointRuleV1, ...] = ()
        elif scope == 'public_network':
            private_rules = ()
            public_rules = tuple(
                rule for rule in self._config.public_network
                if parsed.scheme == 'https'
                and rule.hostname == hostname
                and port in rule.ports
            )
        else:
            raise _invalid_config()
        if not private_rules and not public_rules:
            raise RuntimePolicyError(
                'model_endpoint_host_rejected',
                'Model endpoint is not in the operator policy',
            )
        try:
            raw_addresses = tuple(self._resolver(hostname, port))
        except Exception as exc:
            raise RuntimePolicyError(
                'model_endpoint_dns_rejected',
                'Model endpoint DNS resolution failed',
            ) from exc
        addresses = _authorize_addresses(raw_addresses, scope, private_rules)
        return AuthorizedEndpointV1(
            url=urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', '', '')),
            hostname=hostname,
            port=port,
            addresses=addresses,
            policy_generation=self._config.generation,
            scope=scope,
        )

    def authorize_socket_snapshot(
        self,
        hostname: str,
        port: int,
        addresses: Iterable[str],
        scope: str = 'private_network',
    ) -> tuple[str, ...]:
        normalized_hostname = _canonical_hostname(hostname)
        if scope != 'private_network':
            raise RuntimePolicyError('model_endpoint_host_rejected', 'Socket scope is invalid')
        rules = tuple(
            rule for rule in self._config.private_network
            if rule.hostname == normalized_hostname and port in rule.ports
        )
        if not rules:
            raise RuntimePolicyError('model_endpoint_host_rejected', 'Model endpoint is not in the operator policy')
        return _authorize_addresses(tuple(addresses), scope, rules)


def load_model_endpoint_policy_v1(path: Path | None) -> ModelEndpointPolicyConfigV1:
    return ModelEndpointPolicyConfigV1.deny_all() if path is None else ModelEndpointPolicyConfigV1.load(path)


def install_pinned_socket_transport_v1(
    policy: ModelEndpointPolicyV1,
    scope: str = 'private_network',
) -> Callable[[], None]:
    """Pin every child connection to its single policy-approved DNS snapshot.

    The URL remains hostname-based in the HTTP client, so Host, TLS SNI, CA and
    hostname verification retain their normal semantics. Only getaddrinfo's
    returned socket destinations are replaced with the exact approved snapshot.
    """

    original = _SYSTEM_GETADDRINFO

    def guarded(host: str | bytes | None, port: int | str | None, *args: Any, **kwargs: Any):
        if not isinstance(host, str) or isinstance(port, str) or not isinstance(port, int):
            raise OSError('Network destination is not an allowed HTTP endpoint')
        answers = original(host, port, *args, **kwargs)
        raw_addresses = tuple(dict.fromkeys(item[4][0] for item in answers))
        try:
            approved = set(policy.authorize_socket_snapshot(host, port, raw_addresses, scope))
        except RuntimePolicyError as exc:
            raise OSError('Network destination is not in the operator policy') from exc
        pinned = [
            item for item in answers
            if _canonical_address(item[4][0]) in approved
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


def _parse_private_rule(value: Any) -> PrivateEndpointRuleV1:
    if not isinstance(value, dict) or set(value) != {'hostname', 'cidrs', 'schemes', 'ports'}:
        raise _invalid_config()
    hostname = _canonical_hostname(value.get('hostname'))
    cidrs_raw = _bounded_unique_list(value.get('cidrs'), 1, 32)
    schemes = _bounded_unique_list(value.get('schemes'), 1, 2)
    ports_raw = _bounded_unique_list(value.get('ports'), 1, 16)
    if any(item not in {'http', 'https'} for item in schemes):
        raise _invalid_config()
    cidrs: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for raw in cidrs_raw:
        if not isinstance(raw, str) or len(raw) < 3 or len(raw) > 64:
            raise _invalid_config()
        try:
            network = ipaddress.ip_network(raw, strict=False)
        except ValueError as exc:
            raise _invalid_config() from exc
        if isinstance(network, ipaddress.IPv6Network) and network.network_address.ipv4_mapped is not None:
            raise _invalid_config()
        cidrs.append(network)
    ports = tuple(_port(value) for value in ports_raw)
    return PrivateEndpointRuleV1(hostname, tuple(cidrs), tuple(schemes), ports)


def _parse_public_rule(value: Any) -> PublicEndpointRuleV1:
    if not isinstance(value, dict) or set(value) != {'hostname', 'ports'}:
        raise _invalid_config()
    return PublicEndpointRuleV1(
        hostname=_canonical_hostname(value.get('hostname')),
        ports=tuple(_port(item) for item in _bounded_unique_list(value.get('ports'), 1, 16)),
    )


def _bounded_unique_list(value: Any, minimum: int, maximum: int) -> tuple[Any, ...]:
    if not isinstance(value, list) or len(value) < minimum or len(value) > maximum:
        raise _invalid_config()
    try:
        if len(set(value)) != len(value):
            raise _invalid_config()
    except TypeError as exc:
        raise _invalid_config() from exc
    return tuple(value)


def _port(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 65_535:
        raise _invalid_config()
    return value


def _canonical_hostname(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 253 or value != value.lower():
        raise _invalid_config()
    if value.endswith('.') or '%' in value:
        raise _invalid_config()
    unwrapped = value[1:-1] if value.startswith('[') and value.endswith(']') else value
    try:
        address = ipaddress.ip_address(unwrapped)
    except ValueError:
        labels = value.split('.')
        if any(not _DNS_LABEL.fullmatch(label) or len(label) > 63 for label in labels):
            raise _invalid_config()
        return value
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        raise _invalid_config()
    if address.compressed != unwrapped:
        raise _invalid_config()
    return unwrapped


def _parse_url(raw_url: str) -> SplitResult:
    if (
        not isinstance(raw_url, str)
        or not raw_url
        or len(raw_url) > 2_048
        or any(ord(character) <= 0x20 or ord(character) == 0x7f for character in raw_url)
        or '\\' in raw_url
    ):
        raise RuntimePolicyError('model_endpoint_url_rejected', 'Model endpoint URL is invalid')
    try:
        parsed = urlsplit(raw_url)
        _ = parsed.port
        hostname = _canonical_hostname(parsed.hostname)
    except (ValueError, RuntimePolicyError) as exc:
        raise RuntimePolicyError('model_endpoint_url_rejected', 'Model endpoint URL is invalid') from exc
    if (
        parsed.scheme not in {'http', 'https'}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not hostname
    ):
        raise RuntimePolicyError('model_endpoint_url_rejected', 'Model endpoint URL is invalid')
    return parsed


def _authorize_addresses(
    raw_addresses: tuple[str, ...],
    scope: str,
    private_rules: tuple[PrivateEndpointRuleV1, ...],
) -> tuple[str, ...]:
    if not raw_addresses or len(raw_addresses) > 64:
        raise RuntimePolicyError('model_endpoint_dns_rejected', 'Model endpoint DNS resolution failed')
    normalized: list[str] = []
    for raw in raw_addresses:
        try:
            address = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise RuntimePolicyError('model_endpoint_dns_rejected', 'Model endpoint DNS returned an invalid address') from exc
        if (
            '%' in raw
            or address.compressed.lower() != raw.lower()
            or isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None
        ):
            raise RuntimePolicyError('model_endpoint_dns_rejected', 'Model endpoint DNS returned a non-canonical address')
        if address.is_unspecified or address.is_multicast or address.is_link_local or str(address) == '169.254.169.254':
            raise RuntimePolicyError('model_endpoint_address_rejected', 'Model endpoint resolved to a forbidden address')
        if scope == 'public_network':
            if not address.is_global:
                raise RuntimePolicyError('model_endpoint_address_rejected', 'Public model endpoint is not globally routable')
        elif not any(address in network for rule in private_rules for network in rule.cidrs):
            raise RuntimePolicyError('model_endpoint_address_rejected', 'Private model endpoint is outside the allowed CIDR')
        canonical = address.compressed
        if canonical not in normalized:
            normalized.append(canonical)
    return tuple(normalized)


def _canonical_address(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return ''
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped.compressed
    return address.compressed


def _invalid_config() -> RuntimePolicyError:
    return RuntimePolicyError('invalid_runtime_config', 'Model endpoint policy is invalid', 500)
