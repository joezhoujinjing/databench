from __future__ import annotations

import socket

import pytest

import databench_evalscope.security as security
from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.security import (
    EndpointPolicy,
    install_socket_guard,
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


def test_endpoint_policy_is_default_deny_without_resolving() -> None:
    calls: list[tuple[str, int]] = []
    policy = EndpointPolicy('', resolver=lambda host, port: calls.append((host, port)) or ['203.0.113.10'])
    with pytest.raises(RuntimePolicyError) as captured:
        policy.authorize_connection('https://untrusted.example/v1')
    assert captured.value.code == 'model_endpoint_host_rejected'
    assert calls == []


def test_endpoint_policy_checks_every_dns_answer_and_private_networks() -> None:
    policy = EndpointPolicy(
        'https|model.example|443',
        resolver=lambda _host, _port: ['8.8.8.8', '127.0.0.1'],
    )
    with pytest.raises(RuntimePolicyError) as captured:
        policy.authorize_connection('https://model.example/v1')
    assert captured.value.code == 'model_endpoint_address_rejected'

    private = EndpointPolicy(
        'http|10.20.30.40/32|8080',
        resolver=lambda _host, _port: ['10.20.30.40'],
    )
    authorized = private.authorize_connection('http://model.internal:8080/v1')
    assert authorized.addresses == ('10.20.30.40',)


@pytest.mark.parametrize(
    'url',
    [
        'file:///tmp/model',
        'ftp://model.example/v1',
        'https://user:pass@model.example/v1',
        'https://model.example/v1?token=secret',
        'https://model.example/v1#fragment',
    ],
)
def test_endpoint_policy_rejects_dangerous_url_forms(url: str) -> None:
    policy = EndpointPolicy('https|model.example|443', resolver=lambda _host, _port: ['8.8.8.8'])
    with pytest.raises(RuntimePolicyError):
        policy.authorize_connection(url)


def test_redirects_are_disabled_by_default() -> None:
    policy = EndpointPolicy('https|model.example|443', resolver=lambda _host, _port: ['8.8.8.8'])
    with pytest.raises(RuntimePolicyError) as captured:
        policy.authorize_redirect('https://model.example/v1', '/v2', 0)
    assert captured.value.code == 'model_endpoint_redirect_rejected'


def test_metadata_and_link_local_are_never_allowed() -> None:
    for address in ('169.254.169.254', 'fe80::1'):
        policy = EndpointPolicy(
            f'http|{address}/32|80' if ':' not in address else f'http|{address}/128|80',
            resolver=lambda _host, _port, address=address: [address],
        )
        with pytest.raises(RuntimePolicyError):
            policy.authorize_connection(f'http://[{address}]/' if ':' in address else f'http://{address}/')


def test_socket_guard_uses_the_single_validated_dns_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def getaddrinfo(host: str, port: int, *args: object, **kwargs: object):
        nonlocal calls
        calls += 1
        assert host == 'model.example'
        assert port == 443
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]

    monkeypatch.setattr(security, '_SYSTEM_GETADDRINFO', getaddrinfo)
    monkeypatch.setattr(socket, 'getaddrinfo', getaddrinfo)
    restore = install_socket_guard('https|model.example|443')
    try:
        answers = socket.getaddrinfo('model.example', 443, type=socket.SOCK_STREAM)
    finally:
        restore()
    assert calls == 1
    assert answers[0][4] == ('8.8.8.8', 443)
