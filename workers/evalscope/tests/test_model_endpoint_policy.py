from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest

import databench_evalscope.model_endpoint_policy as model_policy
from databench_evalscope.errors import RuntimePolicyError
from databench_evalscope.model_endpoint_policy import (
    ModelEndpointPolicyConfigV1,
    ModelEndpointPolicyV1,
    install_pinned_socket_transport_v1,
)


def fixture() -> dict:
    path = Path(__file__).resolve().parents[3] / 'docs' / 'models' / 'fixtures' / 'model-endpoint-policy-v1.cases.json'
    return json.loads(path.read_text(encoding='utf-8'))


@pytest.mark.parametrize(
    'case',
    [
        case
        for case in fixture()['required_cases']
        if case['expected'] in {'allow', 'deny', 'ignore-proxy', 'registered-unavailable'}
        and case['id'] != 'redirect'
    ],
    ids=lambda case: case['id'],
)
def test_registered_cross_language_policy_cases(case: dict) -> None:
    document = fixture()
    policy = ModelEndpointPolicyV1(
        document['policy'],
        resolver=lambda _host, _port: case.get('dns_answers', []),
        release_profile=case['release_profile'],
    )
    if case['expected'] in {'allow', 'ignore-proxy'}:
        authorized = policy.authorize_connection(case['url'], case['scope'])
        assert authorized.addresses == tuple(case['dns_answers'])
        assert authorized.policy_generation == 7
        return
    with pytest.raises(RuntimePolicyError) as captured:
        policy.authorize_connection(case['url'], case['scope'])
    assert captured.value.code == case['expected_code']


def test_policy_revalidates_every_connection_and_rejects_rebinding() -> None:
    document = fixture()
    case = next(item for item in document['required_cases'] if item['id'] == 'dns-rebinding-second-resolution')
    snapshots = iter(case['dns_answers_by_call'])
    policy = ModelEndpointPolicyV1(
        document['policy'],
        resolver=lambda _host, _port: next(snapshots),
    )
    assert policy.authorize_connection(case['url']).addresses == ('10.10.0.15',)
    with pytest.raises(RuntimePolicyError) as captured:
        policy.authorize_connection(case['url'])
    assert captured.value.code == 'model_endpoint_address_rejected'


def test_policy_parser_is_strict_and_default_deny_does_not_resolve() -> None:
    document = fixture()
    with pytest.raises(RuntimePolicyError):
        ModelEndpointPolicyConfigV1.parse({**document['policy'], 'extra': True})
    duplicate = json.loads(json.dumps(document['policy']))
    duplicate['private_network'][0]['ports'].append(8000)
    with pytest.raises(RuntimePolicyError):
        ModelEndpointPolicyConfigV1.parse(duplicate)
    calls: list[tuple[str, int]] = []
    deny = ModelEndpointPolicyV1(
        ModelEndpointPolicyConfigV1.deny_all(),
        resolver=lambda host, port: calls.append((host, port)) or ['8.8.8.8'],
    )
    with pytest.raises(RuntimePolicyError) as captured:
        deny.authorize_connection('https://models.example/v1')
    assert captured.value.code == 'model_endpoint_host_rejected'
    assert calls == []


def test_policy_file_loading_rejects_a_symlink(tmp_path: Path) -> None:
    target = tmp_path / 'policy.json'
    target.write_text(json.dumps(fixture()['policy']), encoding='utf-8')
    link = tmp_path / 'policy-link.json'
    link.symlink_to(target)
    with pytest.raises(RuntimePolicyError):
        ModelEndpointPolicyConfigV1.load(link)


def test_pinned_socket_transport_returns_only_the_approved_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def getaddrinfo(host: str, port: int, *args: object, **kwargs: object):
        nonlocal calls
        calls += 1
        assert host == 'model.internal'
        assert port == 8000
        address = '10.10.0.15' if calls == 1 else '169.254.169.254'
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, port))]

    monkeypatch.setattr(model_policy, '_SYSTEM_GETADDRINFO', getaddrinfo)
    monkeypatch.setattr(socket, 'getaddrinfo', getaddrinfo)
    policy = ModelEndpointPolicyV1(fixture()['policy'])
    restore = install_pinned_socket_transport_v1(policy)
    try:
        answers = socket.getaddrinfo('model.internal', 8000, type=socket.SOCK_STREAM)
        assert answers[0][4] == ('10.10.0.15', 8000)
        with pytest.raises(OSError):
            socket.getaddrinfo('model.internal', 8000, type=socket.SOCK_STREAM)
    finally:
        restore()
    assert calls == 2


def test_socket_snapshot_requires_hostname_and_cidr_together() -> None:
    policy = ModelEndpointPolicyV1(fixture()['policy'])
    with pytest.raises(RuntimePolicyError):
        policy.authorize_socket_snapshot('other.internal', 8000, ['10.10.0.15'])
    with pytest.raises(RuntimePolicyError):
        policy.authorize_socket_snapshot('model.internal', 8000, ['10.11.0.15'])
