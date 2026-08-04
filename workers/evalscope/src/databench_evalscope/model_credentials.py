"""Offline Model credential projection, JIT resolution, redaction and FD handoff."""

from __future__ import annotations

import json
import os
import re
import stat
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .errors import RuntimePolicyError

_CREDENTIAL_REF = re.compile(r'^[a-z0-9][a-z0-9._-]{0,127}$')
_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
_AUTHORIZATION = re.compile(r'authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+', re.IGNORECASE)
_MAX_REGISTRY_BYTES = 2 * 1024 * 1024
_MAX_SECRET_BYTES = 8_192


@dataclass(frozen=True)
class ModelCredentialEntryV1:
    secret: str
    allowed_consumers: tuple[str, ...]
    allowed_deployments: tuple[str, ...]


@dataclass(frozen=True)
class ModelCredentialsDocumentV1:
    generation: int
    projection_for: str
    credentials: Mapping[str, ModelCredentialEntryV1]

    @classmethod
    def parse(cls, value: Any) -> 'ModelCredentialsDocumentV1':
        if not isinstance(value, dict) or set(value) != {
            'profile', 'generation', 'projection_for', 'credentials'
        }:
            raise _credential_error('credential_projection_invalid')
        generation = value.get('generation')
        projection_for = value.get('projection_for')
        credentials = value.get('credentials')
        if (
            value.get('profile') != 'model-credentials-v1'
            or isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation < 1
            or generation > 9_007_199_254_740_991
            or projection_for not in {'authority', 'api-health', 'evalscope'}
            or not isinstance(credentials, dict)
            or len(credentials) > 256
        ):
            raise _credential_error('credential_projection_invalid')
        parsed: dict[str, ModelCredentialEntryV1] = {}
        for ref, raw in credentials.items():
            if (
                not isinstance(ref, str)
                or not _CREDENTIAL_REF.fullmatch(ref)
                or '..' in ref
                or not isinstance(raw, dict)
                or set(raw) != {'kind', 'secret', 'allowed_consumers', 'allowed_deployments'}
            ):
                raise _credential_error('credential_projection_invalid')
            secret = raw.get('secret')
            consumers = raw.get('allowed_consumers')
            deployments = raw.get('allowed_deployments')
            if (
                raw.get('kind') != 'bearer'
                or not isinstance(secret, str)
                or not secret
                or len(secret.encode('utf-8')) > _MAX_SECRET_BYTES
                or any(ord(character) <= 31 or ord(character) == 127 for character in secret)
                or not _valid_unique_list(consumers, 1, 2, {'api-health', 'evalscope'})
                or not _valid_unique_list(deployments, 1, 1_024, None)
                or any(not isinstance(item, str) or not _UUID.fullmatch(item) for item in deployments)
            ):
                raise _credential_error('credential_projection_invalid')
            parsed[ref] = ModelCredentialEntryV1(secret, tuple(consumers), tuple(deployments))
        return cls(generation, projection_for, parsed)


class ModelCredentialSnapshotV1:
    __slots__ = ('credential_ref', 'generation', '_secret')

    def __init__(self, credential_ref: str, generation: int, secret: str) -> None:
        self.credential_ref = credential_ref
        self.generation = generation
        self._secret = secret

    def authorization_header(self) -> str:
        return f'Bearer {self._secret}'

    def secret_for_fd_handoff(self) -> str:
        return self._secret

    def __repr__(self) -> str:
        return 'ModelCredentialSnapshotV1(credential_ref=[credential-ref], secret=[redacted])'


class ModelCredentialRegistryV1:
    def __init__(
        self,
        path: Path,
        consumer: str,
        *,
        require_root_owner: bool = True,
    ) -> None:
        if not path.is_absolute() or consumer not in {'api-health', 'evalscope'}:
            raise _credential_error('credential_projection_invalid')
        self._path = path
        self._consumer = consumer
        self._require_root_owner = require_root_owner
        self._document: ModelCredentialsDocumentV1 | None = None

    @property
    def generation(self) -> int | None:
        return None if self._document is None else self._document.generation

    def reload(self, *, allow_generation_rollback: bool = False) -> int:
        document = _read_document(self._path, self._require_root_owner)
        if document.projection_for != self._consumer:
            raise _credential_error('credential_projection_consumer_mismatch')
        if (
            self._document is not None
            and document.generation < self._document.generation
            and not allow_generation_rollback
        ):
            raise _credential_error('credential_generation_rollback_rejected')
        self._document = document
        return document.generation

    def resolve(self, credential_ref: str, deployment_id: str) -> ModelCredentialSnapshotV1:
        if (
            not isinstance(credential_ref, str)
            or not _CREDENTIAL_REF.fullmatch(credential_ref)
            or '..' in credential_ref
            or not isinstance(deployment_id, str)
            or not _UUID.fullmatch(deployment_id)
        ):
            raise _credential_error('credential_reference_invalid')
        if self._document is None:
            raise _credential_error('credential_registry_not_loaded')
        credential = self._document.credentials.get(credential_ref)
        if credential is None:
            raise _credential_error('credential_reference_unknown')
        if (
            self._consumer not in credential.allowed_consumers
            or deployment_id not in credential.allowed_deployments
        ):
            raise _credential_error('credential_reference_forbidden')
        return ModelCredentialSnapshotV1(
            credential_ref,
            self._document.generation,
            credential.secret,
        )

    def redact(self, value: str) -> str:
        output = _AUTHORIZATION.sub('authorization=[redacted]', value)
        if self._document is None:
            return output
        replacements: list[str] = []
        for ref, credential in self._document.credentials.items():
            replacements.extend((ref, credential.secret, f'Bearer {credential.secret}'))
        for candidate in sorted(replacements, key=len, reverse=True):
            output = output.replace(candidate, '[redacted]')
        return output


class AnonymousCredentialFdHandoffV1:
    """One-shot anonymous pipe snapshot; never exposes the secret via repr/argv/env."""

    __slots__ = ('read_fd', '_closed')

    def __init__(self, snapshot: ModelCredentialSnapshotV1) -> None:
        flags = getattr(os, 'O_CLOEXEC', 0)
        read_fd, write_fd = os.pipe2(flags) if hasattr(os, 'pipe2') else os.pipe()
        self.read_fd = read_fd
        self._closed = False
        raw = snapshot.secret_for_fd_handoff().encode('utf-8')
        payload = struct.pack('!I', len(raw)) + raw
        try:
            _write_all(write_fd, payload)
        finally:
            os.close(write_fd)

    @property
    def pass_fds(self) -> tuple[int, ...]:
        if self._closed:
            raise RuntimeError('Credential FD handoff is closed')
        return (self.read_fd,)

    def close(self) -> None:
        if not self._closed:
            os.close(self.read_fd)
            self._closed = True

    def __enter__(self) -> 'AnonymousCredentialFdHandoffV1':
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return 'AnonymousCredentialFdHandoffV1(secret=[redacted])'


def read_anonymous_credential_fd_v1(descriptor: int) -> str:
    try:
        header = _read_exact(descriptor, 4)
        size = struct.unpack('!I', header)[0]
        if size < 1 or size > _MAX_SECRET_BYTES:
            raise _credential_error('credential_handoff_invalid')
        raw = _read_exact(descriptor, size)
        if os.read(descriptor, 1):
            raise _credential_error('credential_handoff_invalid')
        secret = raw.decode('utf-8')
        if any(ord(character) <= 31 or ord(character) == 127 for character in secret):
            raise _credential_error('credential_handoff_invalid')
        return secret
    except (OSError, UnicodeDecodeError, struct.error) as exc:
        raise _credential_error('credential_handoff_invalid') from exc
    finally:
        os.close(descriptor)


def project_model_credentials_v1(value: Any, consumer: str) -> dict[str, Any]:
    authority = ModelCredentialsDocumentV1.parse(value)
    if authority.projection_for != 'authority' or consumer not in {'api-health', 'evalscope'}:
        raise _credential_error('credential_authority_profile_required')
    credentials: dict[str, Any] = {}
    raw_credentials = value['credentials']
    for ref, entry in authority.credentials.items():
        if consumer in entry.allowed_consumers:
            credentials[ref] = raw_credentials[ref]
    return {
        'profile': 'model-credentials-v1',
        'generation': authority.generation,
        'projection_for': consumer,
        'credentials': credentials,
    }


def _read_document(path: Path, require_root_owner: bool) -> ModelCredentialsDocumentV1:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except OSError as exc:
        raise _credential_error('credential_projection_unavailable') from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_size <= 0
            or metadata.st_size > _MAX_REGISTRY_BYTES
            or metadata.st_mode & 0o022
            or require_root_owner and metadata.st_uid != 0
        ):
            raise _credential_error('credential_projection_permissions_invalid')
        raw = os.read(descriptor, metadata.st_size + 1)
    finally:
        os.close(descriptor)
    try:
        return ModelCredentialsDocumentV1.parse(json.loads(raw.decode('utf-8')))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _credential_error('credential_projection_invalid') from exc


def _valid_unique_list(value: Any, minimum: int, maximum: int, allowed: set[str] | None) -> bool:
    return (
        isinstance(value, list)
        and minimum <= len(value) <= maximum
        and all(isinstance(item, str) for item in value)
        and len(set(value)) == len(value)
        and (allowed is None or all(item in allowed for item in value))
    )


def _read_exact(descriptor: int, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = os.read(descriptor, remaining)
        if not chunk:
            raise _credential_error('credential_handoff_invalid')
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


def _write_all(descriptor: int, value: bytes) -> None:
    offset = 0
    while offset < len(value):
        written = os.write(descriptor, value[offset:])
        if written <= 0:
            raise OSError('short pipe write')
        offset += written


def _credential_error(code: str) -> RuntimePolicyError:
    return RuntimePolicyError(code, 'Model credential operation failed', 503)
