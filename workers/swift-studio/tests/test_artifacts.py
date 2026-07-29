import io
import json
import os
import socket
import tarfile
from dataclasses import asdict, replace
from pathlib import Path

import pytest
import zstandard
from blake3 import blake3

from databench_swift_studio.artifacts import (
    ArtifactCore,
    ArtifactLimits,
    ArtifactSessionContext,
)
from databench_swift_studio.errors import ProviderError

SESSION_ID = 'sws_' + 'a' * 43
DATASET_VERSION = 'ab' * 32
EXPORT_BYTES = b'{}\n'
EXPORT_DIGEST = blake3(EXPORT_BYTES).hexdigest()


class Contexts:
    def __init__(self, context: ArtifactSessionContext):
        self.context = context

    def artifact_context(self, provider_session_id: str) -> ArtifactSessionContext:
        if provider_session_id != self.context.provider_session_id:
            raise ProviderError('provider_session_not_current', 'not current', 409)
        return self.context


def context(tmp_path: Path) -> ArtifactSessionContext:
    root = tmp_path / 'sessions' / SESSION_ID
    (root / 'input').mkdir(parents=True)
    (root / 'output').mkdir()
    (root / 'input' / 'ms-swift.jsonl').write_bytes(EXPORT_BYTES)
    return ArtifactSessionContext(
        provider_generation='spg_test_generation',
        provider_session_id=SESSION_ID,
        session_root=root,
        dataset_version=DATASET_VERSION,
        export_digest=EXPORT_DIGEST,
        export_size_bytes=len(EXPORT_BYTES),
        output_count=1,
    )


def write_json(path: Path, value) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')),
        encoding='utf-8',
    )


def raw_safetensors_bytes(header: dict, payload: bytes) -> bytes:
    raw_header = json.dumps(
        header,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    raw_header += b' ' * (-len(raw_header) % 8)
    return len(raw_header).to_bytes(8, byteorder='little') + raw_header + payload


def safetensors_bytes(tensors: dict[str, bytes]) -> bytes:
    offset = 0
    header = {}
    payload = bytearray()
    for name, data in tensors.items():
        assert len(data) > 0 and len(data) % 4 == 0
        header[name] = {
            'dtype': 'F32',
            'shape': [len(data) // 4],
            'data_offsets': [offset, offset + len(data)],
        }
        offset += len(data)
        payload.extend(data)
    return raw_safetensors_bytes(header, bytes(payload))


def valid_candidate(session: ArtifactSessionContext, relative='run/checkpoint-1') -> Path:
    candidate = session.session_root / 'output' / relative
    candidate.mkdir(parents=True)
    write_json(
        candidate / 'adapter_config.json',
        {
            'base_model_name_or_path': 'Qwen/Qwen3-0.6B',
            'bias': 'none',
            'lora_alpha': 16,
            'lora_dropout': 0.05,
            'peft_type': 'LORA',
            'r': 8,
            'target_modules': ['q_proj', 'v_proj'],
            'task_type': 'CAUSAL_LM',
        },
    )
    (candidate / 'adapter_model.safetensors').write_bytes(
        safetensors_bytes({'base_model.layers.0.lora_A.weight': b'\x00\x00\x00\x00'})
    )
    write_json(
        candidate / 'tokenizer_config.json',
        {'model_max_length': 128},
    )
    write_json(
        candidate / 'args.json',
        {
            'dataset': [str(session.session_root / 'input' / 'ms-swift.jsonl')],
            'dtype': 'bfloat16',
            'learning_rate': 0.0001,
            'lora_rank': 8,
            'max_length': 128,
            'max_steps': 3,
            'model': 'Qwen/Qwen3-0.6B',
            'output_dir': str(candidate),
            'seed': 42,
            'token': 'must-not-leak',
            'train_type': 'sft',
            'tuner_type': 'lora',
        },
    )
    (candidate / 'training_args.bin').write_bytes(b'LOCKED-MS-SWIFT-TRAINING-ARGS')
    return candidate


def archive_members(raw: bytes) -> list[tuple[tarfile.TarInfo, bytes]]:
    result = []
    with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)) as reader:
        with tarfile.open(fileobj=reader, mode='r|') as archive:
            for member in archive:
                extracted = archive.extractfile(member)
                assert extracted is not None
                result.append((member, extracted.read()))
    return result


def discover_one(core: ArtifactCore):
    candidates = core.discover(SESSION_ID)
    assert len(candidates) == 1
    return candidates[0]


def test_discovers_opaque_snapshot_and_builds_deterministic_sanitized_archive(
    tmp_path: Path,
):
    session = context(tmp_path)
    valid_candidate(session)
    core = ArtifactCore(Contexts(session))

    candidate = discover_one(core)
    assert candidate.importable is True
    assert candidate.handle is not None
    assert candidate.handle.startswith('swo_')
    assert 'checkpoint' not in candidate.handle
    assert str(tmp_path) not in json.dumps(asdict(candidate))
    assert candidate.display_name == 'checkpoint-1'
    assert candidate.candidate_kinds == ('lora_adapter',)

    first_path = tmp_path / 'first.tar.zst'
    second_path = tmp_path / 'second.tar.zst'
    first = core.build_lora_adapter(candidate.handle, first_path)
    second = core.build_lora_adapter(candidate.handle, second_path)

    assert first_path.read_bytes() == second_path.read_bytes()
    assert first.archive_digest == second.archive_digest
    assert first.archive_digest == blake3(first_path.read_bytes()).hexdigest()
    assert first.archive_size_bytes == first_path.stat().st_size
    assert first_path.stat().st_mode & 0o777 == 0o440
    assert first.archive_digest == (
        '7509051c2def2efcfedfeb81b284c78fa22a6d0e63d25b9586b8618e6f9100a7'
    )

    members = archive_members(first_path.read_bytes())
    assert [member.name for member, _ in members] == [
        'adapter_config.json',
        'adapter_model.safetensors',
        'tokenizer_config.json',
    ]
    assert all(member.mtime == 0 for member, _ in members)
    assert all(member.uid == 0 and member.gid == 0 for member, _ in members)
    assert all(member.uname == '' and member.gname == '' for member, _ in members)
    assert all(member.mode == 0o444 for member, _ in members)

    manifest_text = json.dumps(first.provider_metadata, sort_keys=True)
    assert 'args.json' not in manifest_text
    assert 'must-not-leak' not in manifest_text
    assert str(tmp_path) not in manifest_text
    assert first.provider_metadata['provider_metadata_version'] == (
        'swift-lora-snapshot-v1'
    )
    assert first.provider_metadata['dataset_lineage'] == {
        'status': 'verified',
        'dataset_version': DATASET_VERSION,
        'dataset_export_digest': EXPORT_DIGEST,
    }
    assert first.provider_metadata['base_model'] == {
        'reference': 'Qwen/Qwen3-0.6B',
        'revision': None,
        'binding_status': 'declared',
    }
    assert first.provider_metadata['adapter'] == {
        'peft_type': 'LORA',
        'task_type': 'CAUSAL_LM',
        'rank': 8,
        'alpha': 16,
        'dropout': 0.05,
        'bias': 'none',
        'target_modules': ['q_proj', 'v_proj'],
    }
    assert first.provider_metadata['training_summary'] == {
        'train_stage': 'sft',
        'tuner_type': 'lora',
        'lora_rank': 8,
        'lora_alpha': None,
        'lora_dropout': None,
        'num_train_epochs': None,
        'max_steps': 3,
        'learning_rate': 0.0001,
        'max_length': 128,
        'dtype': 'bfloat16',
        'seed': 42,
        'redacted_fields_count': 2,
    }


def test_rejects_snapshot_change_and_never_exposes_a_partial_archive(tmp_path: Path):
    session = context(tmp_path)
    candidate_root = valid_candidate(session)
    core = ArtifactCore(Contexts(session))
    handle = discover_one(core).handle
    assert handle is not None
    (candidate_root / 'adapter_model.safetensors').write_bytes(b'changed')
    destination = tmp_path / 'changed.tar.zst'

    with pytest.raises(ProviderError, match='changed after discovery') as error:
        core.build_lora_adapter(handle, destination)

    assert error.value.code == 'output_snapshot_changed'
    assert not destination.exists()
    assert not list(tmp_path.glob('.*.partial'))


def test_stops_archive_construction_at_the_staging_byte_limit(tmp_path: Path):
    session = context(tmp_path)
    valid_candidate(session)
    core = ArtifactCore(Contexts(session))
    handle = discover_one(core).handle
    assert handle is not None
    destination = tmp_path / 'oversized.tar.zst'

    with pytest.raises(ProviderError) as error:
        core.build_lora_adapter(handle, destination, max_archive_bytes=1)

    assert error.value.code == 'artifact_archive_too_large'
    assert not destination.exists()
    assert not list(tmp_path.glob('.*.partial'))


def test_rejects_handle_from_another_provider_generation(tmp_path: Path):
    session = context(tmp_path)
    valid_candidate(session)
    contexts = Contexts(session)
    core = ArtifactCore(contexts)
    handle = discover_one(core).handle
    assert handle is not None
    contexts.context = replace(session, provider_generation='spg_next_generation')

    with pytest.raises(ProviderError) as error:
        core.build_lora_adapter(handle, tmp_path / 'stale.tar.zst')

    assert error.value.code == 'output_handle_stale'


def test_downgrades_lineage_when_exact_session_export_bytes_changed(tmp_path: Path):
    session = context(tmp_path)
    valid_candidate(session)
    core = ArtifactCore(Contexts(session))
    handle = discover_one(core).handle
    assert handle is not None
    (session.session_root / 'input' / 'ms-swift.jsonl').write_bytes(b'{"changed":true}\n')

    result = core.build_lora_adapter(handle, tmp_path / 'unverified.tar.zst')

    assert result.provider_metadata['dataset_lineage'] == {
        'status': 'external_or_unverified',
        'dataset_version': None,
        'dataset_export_digest': None,
    }


@pytest.mark.parametrize(
    ('mutation', 'reason'),
    [
        (
            lambda candidate: (candidate / 'mystery.bin').write_bytes(b'unknown'),
            'output_candidate_unknown_file',
        ),
        (
            lambda candidate: (candidate / 'training.pkl').write_bytes(b'pickle'),
            'output_candidate_unknown_file',
        ),
        (
            lambda candidate: (candidate / 'nested').mkdir(),
            'output_candidate_unknown_file',
        ),
        (
            lambda candidate: (
                candidate / 'adapter_model.safetensors'
            ).unlink(),
            'output_candidate_adapter_shape_invalid',
        ),
    ],
)
def test_marks_non_allowlisted_or_incomplete_candidates_unimportable(
    tmp_path: Path,
    mutation,
    reason: str,
):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-1')
    mutation(candidate_root)

    candidate = discover_one(ArtifactCore(Contexts(session)))

    assert candidate.importable is False
    assert candidate.handle is None
    assert candidate.reason == reason
    assert str(tmp_path) not in json.dumps(asdict(candidate))


def test_excludes_locked_ms_swift_resume_and_log_files_without_blocking_adapter(
    tmp_path: Path,
):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-1')
    excluded = {
        'README.md': b'---\nbase_model: Qwen/Qwen3-0.6B\n---\n',
        'events.out.tfevents.1722123456.host': b'tensorboard',
        'optimizer.pt': b'optimizer-pickle',
        'rng_state.pth': b'rng-pickle',
        'rng_state_0.pth': b'rng-rank-pickle',
        'scheduler.pt': b'scheduler-pickle',
        'train.log': b'complete-training-log',
        'trainer_state.json': b'{"global_step":3}',
    }
    for name, raw in excluded.items():
        (candidate_root / name).write_bytes(raw)

    core = ArtifactCore(Contexts(session))
    candidate = discover_one(core)
    assert candidate.importable is True
    assert candidate.handle is not None
    archive = tmp_path / 'locked-layout.tar.zst'
    core.build_lora_adapter(candidate.handle, archive)
    member_names = [member.name for member, _ in archive_members(archive.read_bytes())]

    assert 'training_args.bin' not in member_names
    assert not set(excluded).intersection(member_names)


def test_imports_the_locked_ms_swift_peft_lora_output_layout(tmp_path: Path):
    layout = json.loads(
        (
            Path(__file__).parent
            / 'fixtures'
            / 'ms-swift-v4.4.2-peft-lora-layout.json'
        ).read_text(encoding='utf-8')
    )
    assert layout['source'] == {
        'image_id': (
            'sha256:57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d'
        ),
        'ms_swift': '4.4.2',
        'peft': '0.19.1',
        'transformers': '4.57.6',
        'safetensors': '0.8.0',
        'platform': 'linux/amd64',
        'captured_at': '2026-07-28',
    }
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-locked-layout')
    (candidate_root / 'tokenizer_config.json').unlink()
    write_json(candidate_root / 'adapter_config.json', layout['adapter_config'])
    write_json(
        candidate_root / 'additional_config.json',
        {
            'lora_dtype': None,
            'lorap_lr_ratio': None,
            'lorap_emb_lr': 1e-6,
        },
    )
    (candidate_root / 'README.md').write_text(
        '---\nbase_model: Qwen/Qwen3-0.6B\nlibrary_name: peft\n---\n',
        encoding='utf-8',
    )
    for name in [
        'optimizer.pt',
        'rng_state.pth',
        'scheduler.pt',
        'trainer_state.json',
    ]:
        (candidate_root / name).write_bytes(b'locked-ms-swift-checkpoint-state')
    version_root = candidate_root.parent
    write_json(version_root / 'args.json', {'output_dir': str(version_root)})
    (version_root / 'logging.jsonl').write_text(
        '{"global_step":1,"loss":1.0}\n',
        encoding='utf-8',
    )
    assert sorted(path.name for path in version_root.iterdir()) == [
        'args.json',
        'checkpoint-locked-layout',
        'logging.jsonl',
    ]
    assert sorted(path.name for path in candidate_root.iterdir()) == (
        layout['checkpoint_files']
    )

    core = ArtifactCore(Contexts(session))
    candidate = discover_one(core)
    assert candidate.importable is True
    assert candidate.handle is not None
    archive = tmp_path / 'locked-ms-swift-layout.tar.zst'
    core.build_lora_adapter(candidate.handle, archive)

    assert [member.name for member, _ in archive_members(archive.read_bytes())] == (
        layout['archive_files']
    )


def test_redacts_training_values_outside_the_typescript_contract(tmp_path: Path):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-1')
    args_path = candidate_root / 'args.json'
    args = json.loads(args_path.read_text(encoding='utf-8'))
    args.update(
        {
            'learning_rate': 0,
            'lora_alpha': -1,
            'lora_dropout': 2,
            'lora_rank': 0,
            'max_length': 0,
            'max_steps': -1,
            'num_train_epochs': 0,
        }
    )
    write_json(args_path, args)
    core = ArtifactCore(Contexts(session))
    candidate = discover_one(core)
    assert candidate.handle is not None

    summary = core.build_lora_adapter(
        candidate.handle,
        tmp_path / 'invalid-summary.tar.zst',
    ).provider_metadata['training_summary']

    assert summary['learning_rate'] is None
    assert summary['lora_alpha'] is None
    assert summary['lora_dropout'] is None
    assert summary['lora_rank'] is None
    assert summary['max_length'] is None
    assert summary['max_steps'] is None
    assert summary['num_train_epochs'] is None
    assert summary['redacted_fields_count'] >= 7


@pytest.mark.parametrize(
    'value',
    [
        {
            'lora_dtype': None,
            'lorap_lr_ratio': None,
            'lorap_emb_lr': 1e-6,
            'token': 'must-not-pass',
        },
        {
            'lora_dtype': 'int8',
            'lorap_lr_ratio': None,
            'lorap_emb_lr': 1e-6,
        },
        {
            'lora_dtype': None,
            'lorap_lr_ratio': -1,
            'lorap_emb_lr': 1e-6,
        },
    ],
)
def test_rejects_invalid_locked_ms_swift_additional_config(tmp_path: Path, value: dict):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-additional-config')
    write_json(candidate_root / 'additional_config.json', value)

    candidate = discover_one(ArtifactCore(Contexts(session)))

    assert candidate.importable is False
    assert candidate.reason == 'output_candidate_additional_config_invalid'


def test_rejects_symlink_fifo_and_socket_entries(tmp_path: Path):
    for index, kind in enumerate(('symlink', 'fifo', 'socket')):
        case = tmp_path / kind
        session = context(case)
        candidate_root = valid_candidate(session, f'checkpoint-{index}')
        unsafe = candidate_root / 'adapter_model.safetensors'
        unsafe.unlink()
        sock = None
        if kind == 'symlink':
            unsafe.symlink_to(candidate_root / 'adapter_config.json')
        elif kind == 'fifo':
            os.mkfifo(unsafe)
        else:
            sock = socket.socket(socket.AF_UNIX)
            short_socket = Path(f'/tmp/databench-swift-{os.getpid()}-{index}.sock')
            try:
                short_socket.unlink()
            except FileNotFoundError:
                pass
            sock.bind(str(short_socket))
            short_socket.rename(unsafe)
        try:
            candidate = discover_one(ArtifactCore(Contexts(session)))
            assert candidate.importable is False
            assert candidate.reason == 'output_candidate_unsafe_file'
        finally:
            if sock is not None:
                sock.close()


def test_enforces_file_and_scan_bounds(tmp_path: Path):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-1')
    limits = ArtifactLimits(
        max_scan_entries=16,
        max_candidates=8,
        max_handles=8,
        max_files=8,
        max_file_bytes=8,
        max_total_bytes=32,
        max_json_bytes=8,
        max_args_bytes=8,
    )
    candidate = discover_one(ArtifactCore(Contexts(session), limits=limits))
    assert candidate.importable is False
    assert candidate.reason in {
        'output_candidate_file_too_large',
        'output_candidate_metadata_too_large',
    }

    for index in range(4):
        (session.session_root / 'output' / f'extra-{index}').mkdir()
    with pytest.raises(ProviderError) as error:
        ArtifactCore(
            Contexts(session),
            limits=replace(limits, max_scan_entries=3, max_candidates=3),
        ).discover(SESSION_ID)
    assert error.value.code == 'output_discovery_limit_exceeded'


def test_accepts_complete_sharded_safetensors_and_rejects_index_drift(tmp_path: Path):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-sharded')
    (candidate_root / 'adapter_model.safetensors').unlink()
    shards = [
        'adapter_model-00001-of-00002.safetensors',
        'adapter_model-00002-of-00002.safetensors',
    ]
    (candidate_root / shards[0]).write_bytes(safetensors_bytes({'a': b'\x00' * 4}))
    (candidate_root / shards[1]).write_bytes(safetensors_bytes({'b': b'\x01' * 4}))
    write_json(
        candidate_root / 'adapter_model.safetensors.index.json',
        {
            'metadata': {'total_size': 8},
            'weight_map': {'a': shards[0], 'b': shards[1]},
        },
    )
    assert discover_one(ArtifactCore(Contexts(session))).importable is True

    write_json(
        candidate_root / 'adapter_model.safetensors.index.json',
        {'weight_map': {'a': shards[0]}},
    )
    drifted = discover_one(ArtifactCore(Contexts(session)))
    assert drifted.importable is False
    assert drifted.reason == 'output_candidate_adapter_shape_invalid'


def test_rejects_malformed_safetensors_and_shard_tensor_mapping_drift(tmp_path: Path):
    malformed_session = context(tmp_path / 'malformed')
    malformed_root = valid_candidate(malformed_session, 'checkpoint-malformed')
    (malformed_root / 'adapter_model.safetensors').write_bytes(b'not-safetensors')

    malformed = discover_one(ArtifactCore(Contexts(malformed_session)))

    assert malformed.importable is False
    assert malformed.reason == 'output_candidate_safetensors_invalid'

    sharded_session = context(tmp_path / 'mapping')
    sharded_root = valid_candidate(sharded_session, 'checkpoint-sharded')
    (sharded_root / 'adapter_model.safetensors').unlink()
    shards = [
        'adapter_model-00001-of-00002.safetensors',
        'adapter_model-00002-of-00002.safetensors',
    ]
    (sharded_root / shards[0]).write_bytes(safetensors_bytes({'a': b'\x00' * 4}))
    (sharded_root / shards[1]).write_bytes(safetensors_bytes({'b': b'\x01' * 4}))
    write_json(
        sharded_root / 'adapter_model.safetensors.index.json',
        {
            'metadata': {'total_size': 8},
            'weight_map': {'a': shards[1], 'b': shards[0]},
        },
    )

    drifted = discover_one(ArtifactCore(Contexts(sharded_session)))

    assert drifted.importable is False
    assert drifted.reason == 'output_candidate_adapter_shape_invalid'


@pytest.mark.parametrize(
    ('header', 'payload'),
    [
        (
            {'tensor': {'dtype': 'F32', 'shape': [1], 'data_offsets': [0, 8]}},
            b'\x00' * 8,
        ),
        (
            {'tensor': {'dtype': 'F32', 'shape': [1], 'data_offsets': [1, 5]}},
            b'\x00' * 5,
        ),
        (
            {'tensor': {'dtype': 'UNKNOWN', 'shape': [1], 'data_offsets': [0, 4]}},
            b'\x00' * 4,
        ),
    ],
)
def test_rejects_safetensors_shape_range_and_dtype_drift(
    tmp_path: Path,
    header: dict,
    payload: bytes,
):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-invalid-header')
    (candidate_root / 'adapter_model.safetensors').write_bytes(
        raw_safetensors_bytes(header, payload)
    )

    candidate = discover_one(ArtifactCore(Contexts(session)))

    assert candidate.importable is False
    assert candidate.reason == 'output_candidate_safetensors_invalid'


def test_rejects_credential_fields_in_archived_adapter_metadata(tmp_path: Path):
    session = context(tmp_path)
    candidate_root = valid_candidate(session, 'checkpoint-sensitive')
    config = json.loads((candidate_root / 'adapter_config.json').read_text())
    config['api_token'] = 'sk-proj-1234567890abcdef'
    write_json(candidate_root / 'adapter_config.json', config)

    candidate = discover_one(ArtifactCore(Contexts(session)))

    assert candidate.importable is False
    assert candidate.reason == 'output_candidate_metadata_sensitive'


def test_conditional_archive_create_never_overwrites_existing_destination(tmp_path: Path):
    session = context(tmp_path)
    valid_candidate(session)
    core = ArtifactCore(Contexts(session))
    handle = discover_one(core).handle
    assert handle is not None
    destination = tmp_path / 'existing.tar.zst'
    destination.write_bytes(b'keep')

    with pytest.raises(ProviderError) as error:
        core.build_lora_adapter(handle, destination)

    assert error.value.code == 'artifact_destination_exists'
    assert destination.read_bytes() == b'keep'
