import { describe, expect, test } from 'vitest'
import {
  CreateModelArtifactImportRequestV2Schema,
  ModelArtifactImportV2Schema,
  ModelArtifactManifestV2Schema,
  ModelArtifactV2Schema,
  SwiftStudioOutputCandidateV2Schema,
  SwiftStudioProviderArtifactImportV2Schema,
} from '../src/index.js'

const NOW = '2026-07-29T00:00:00.000Z'
const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const IMPORT_ID = '22222222-2222-4222-8222-222222222222'
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333'
const DIGEST = 'a'.repeat(64)
const ARCHIVE_DIGEST = 'b'.repeat(64)
const MANIFEST_DIGEST = 'c'.repeat(64)
const VERSION = 'd'.repeat(64)
const EXPORT_DIGEST = 'e'.repeat(64)

function manifest() {
  return {
    manifest_version: 'model-artifact-manifest-v1',
    artifact_kind: 'lora_adapter',
    artifact_format: 'swift-lora-adapter-v1',
    archive_format: 'deterministic-tar-zst-v1',
    archive_digest: ARCHIVE_DIGEST,
    archive_size_bytes: 1_024,
    output_snapshot_digest: DIGEST,
    files: [
      { path: 'adapter_config.json', digest: '1'.repeat(64), size_bytes: 128 },
      { path: 'adapter_model.safetensors', digest: '2'.repeat(64), size_bytes: 896 },
    ],
    source: {
      studio_session_id: SESSION_ID,
      upstream_commit: 'f'.repeat(40),
      image_digest: '3'.repeat(64),
    },
    dataset_lineage: {
      status: 'verified',
      dataset_version: VERSION,
      dataset_export_digest: EXPORT_DIGEST,
    },
    base_model: {
      reference: 'Qwen/Qwen3-0.6B',
      revision: '0123456789abcdef',
      binding_status: 'verified',
    },
    training_summary: {
      train_stage: 'sft',
      tuner_type: 'lora',
      lora_rank: 8,
      lora_alpha: 16,
      lora_dropout: 0.05,
      num_train_epochs: null,
      max_steps: 5,
      learning_rate: 0.0001,
      max_length: 128,
      dtype: 'bfloat16',
      seed: 42,
      redacted_fields_count: 4,
    },
    created_at: NOW,
    created_by: 'databench',
  }
}

describe('V2 LoRA Model Artifact contracts', () => {
  test('accepts only opaque output handles and bounded create requests', () => {
    const request = {
      studio_session_id: SESSION_ID,
      output_handle: `out_${'A'.repeat(32)}`,
      artifact_kind: 'lora_adapter',
      display_name: 'customer-service-lora',
      base_model: { reference: 'Qwen/Qwen3-0.6B', revision: null },
    }
    expect(CreateModelArtifactImportRequestV2Schema.parse(request)).toEqual(request)
    for (const invalid of [
      { ...request, output_handle: '/workspace/sessions/output' },
      { ...request, display_name: '/tmp/adapter' },
      { ...request, base_model: { reference: 'file:///models/qwen', revision: null } },
      { ...request, display_name: 'token=secret-value' },
      { ...request, artifact_kind: 'full_model' },
      { ...request, unknown: true },
    ]) {
      expect(CreateModelArtifactImportRequestV2Schema.safeParse(invalid).success).toBe(false)
    }
  })

  test('keeps output discovery relative and explicitly importable', () => {
    const candidate = {
      handle: `out_${'B'.repeat(32)}`,
      display_name: 'checkpoint-5',
      candidate_kinds: ['lora_adapter'],
      size_bytes: 1_024,
      modified_at: NOW,
      importable: true,
      reason: null,
    }
    expect(SwiftStudioOutputCandidateV2Schema.parse(candidate)).toEqual(candidate)
    expect(
      SwiftStudioOutputCandidateV2Schema.safeParse({
        ...candidate,
        importable: false,
        reason: null,
      }).success,
    ).toBe(false)
  })

  test('requires a deterministic allowlisted sanitized manifest', () => {
    expect(ModelArtifactManifestV2Schema.parse(manifest())).toEqual(manifest())
    const withSwiftAdditionalConfig = {
      ...manifest(),
      files: [
        ...manifest().files,
        { path: 'additional_config.json', digest: '3'.repeat(64), size_bytes: 80 },
      ],
    }
    expect(ModelArtifactManifestV2Schema.parse(withSwiftAdditionalConfig)).toEqual(
      withSwiftAdditionalConfig,
    )
    expect(
      ModelArtifactManifestV2Schema.safeParse({
        ...manifest(),
        files: [
          { path: 'args.json', digest: '1'.repeat(64), size_bytes: 1 },
          { path: 'adapter_model.safetensors', digest: '2'.repeat(64), size_bytes: 2 },
        ],
      }).success,
    ).toBe(false)
    expect(
      ModelArtifactManifestV2Schema.safeParse({
        ...manifest(),
        base_model: {
          ...manifest().base_model,
          reference: '/workspace/cache/model',
        },
      }).success,
    ).toBe(false)
    expect(
      ModelArtifactManifestV2Schema.safeParse({
        ...manifest(),
        training_summary: {
          ...manifest().training_summary,
          environment: { API_TOKEN: 'secret' },
        },
      }).success,
    ).toBe(false)
  })

  test('enforces import lifecycle and hides staging locators from public views', () => {
    const requested = {
      id: IMPORT_ID,
      create_digest: DIGEST,
      status: 'requested',
      studio_session_id: SESSION_ID,
      artifact_kind: 'lora_adapter',
      display_name: 'customer-service-lora',
      base_model: { reference: 'Qwen/Qwen3-0.6B', revision: 'main' },
      output_snapshot_digest: null,
      archive_digest: null,
      archive_size_bytes: null,
      manifest_digest: null,
      artifact_id: null,
      failure: null,
      created_at: NOW,
      staging_at: null,
      finalizing_at: null,
      completed_at: null,
      failed_at: null,
      updated_at: NOW,
    }
    expect(ModelArtifactImportV2Schema.parse(requested)).toEqual(requested)
    expect(
      ModelArtifactImportV2Schema.safeParse({
        ...requested,
        status: 'completed',
        artifact_id: ARTIFACT_ID,
      }).success,
    ).toBe(false)
    expect(
      ModelArtifactImportV2Schema.safeParse({
        ...requested,
        staging_object_key: `staging/swift-artifact/v1/${IMPORT_ID}/archive.tar.zst`,
      }).success,
    ).toBe(false)
  })

  test('binds Provider staging terminal metadata and immutable Artifact metadata', () => {
    const providerImport = {
      provider_import_id: `swai_${'A'.repeat(32)}`,
      request_id: DIGEST,
      provider_session_id: `sws_${'B'.repeat(32)}`,
      provider_generation: 'generation-1',
      status: 'staged',
      output_snapshot_digest: DIGEST,
      staging_object_key: `staging/swift-artifact/v1/${IMPORT_ID}/archive.tar.zst`,
      archive_digest: ARCHIVE_DIGEST,
      archive_size_bytes: 1_024,
      provider_metadata: {
        provider_metadata_version: 'swift-lora-snapshot-v1',
        artifact_kind: 'lora_adapter',
        artifact_format: 'swift-lora-adapter-v1',
        archive_format: 'deterministic-tar-zst-v1',
        source: {
          provider_generation: 'generation-1',
          provider_session_id: `sws_${'B'.repeat(32)}`,
        },
        adapter: { peft_type: 'LORA', rank: 8, target_modules: ['q_proj'] },
        base_model: {
          reference: 'Qwen/Qwen3-0.6B',
          revision: '0123456789abcdef',
          binding_status: 'verified',
        },
        training_summary: manifest().training_summary,
        dataset_lineage: manifest().dataset_lineage,
        archive_digest_algorithm: 'blake3',
        archive_digest: ARCHIVE_DIGEST,
        archive_size_bytes: 1_024,
        output_snapshot_digest: DIGEST,
        files: manifest().files.map((file) => ({ ...file, digest_algorithm: 'blake3' })),
      },
      failure: null,
      replayed: false,
    }
    expect(SwiftStudioProviderArtifactImportV2Schema.parse(providerImport)).toEqual(providerImport)

    const artifact = {
      id: ARTIFACT_ID,
      display_name: 'customer-service-lora',
      artifact_kind: 'lora_adapter',
      artifact_format: 'swift-lora-adapter-v1',
      archive_format: 'deterministic-tar-zst-v1',
      archive_digest: ARCHIVE_DIGEST,
      archive_size_bytes: 1_024,
      manifest_digest: MANIFEST_DIGEST,
      manifest: manifest(),
      source: { studio_session_id: SESSION_ID, import_id: IMPORT_ID },
      dataset_lineage: manifest().dataset_lineage,
      base_model: manifest().base_model,
      upstream_commit: manifest().source.upstream_commit,
      image_digest: manifest().source.image_digest,
      created_at: NOW,
    }
    expect(ModelArtifactV2Schema.parse(artifact)).toEqual(artifact)
  })
})
