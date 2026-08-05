import { ValidationError } from '@databench/schema'
import { describe, expect, test } from 'vitest'
import { V2CursorCodec } from '../src/v2/cursor.js'

const SECRET = '0123456789abcdef-v2-cursor-secret'
const NAMESPACE = 'default'

function expectInvalidCursor(action: () => unknown): void {
  expect(action).toThrowError(
    expect.objectContaining({
      name: 'ValidationError',
      code: 'validation_error',
      message: 'Invalid or expired V2 refs cursor',
      detail: {
        issues: [
          {
            path: '/cursor',
            line: null,
            code: 'invalid_cursor',
            message: 'Invalid cursor',
          },
        ],
      },
    }),
  )
  expect(action).toThrow(ValidationError)
}

function expectInvalidLineageCursor(action: () => unknown): void {
  expect(action).toThrowError(
    expect.objectContaining({
      name: 'ValidationError',
      code: 'validation_error',
      message: 'Invalid or expired V2 lineage cursor',
    }),
  )
}

describe('V2CursorCodec', () => {
  test('round-trips signed ref cursors across valid C-collation punctuation', () => {
    const codec = new V2CursorCodec(SECRET)

    for (const after of ['a-', 'a-ref', 'a.', 'a0', 'a_']) {
      const cursor = codec.encodeRef(NAMESPACE, after)

      expect(cursor.split('.')).toHaveLength(2)
      expect(codec.decodeRef(cursor, NAMESPACE)).toBe(after)
    }
  })

  test('rejects payload and signature tampering with the same public error', () => {
    const codec = new V2CursorCodec(SECRET)
    const cursor = codec.encodeRef(NAMESPACE, 'a-ref')
    const [encodedPayload, encodedSignature] = cursor.split('.') as [string, string]
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    payload.after = 'z-ref'
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = Buffer.from(encodedSignature, 'base64url')
    signature[0] = (signature[0] ?? 0) ^ 1

    expectInvalidCursor(() => codec.decodeRef(`${tamperedPayload}.${encodedSignature}`, NAMESPACE))
    expectInvalidCursor(() =>
      codec.decodeRef(`${encodedPayload}.${signature.toString('base64url')}`, NAMESPACE),
    )
    expectInvalidCursor(() => codec.decodeRef(`${encodedPayload}!.${encodedSignature}`, NAMESPACE))
    expectInvalidCursor(() => codec.decodeRef(`${encodedPayload}.${encodedSignature}!`, NAMESPACE))
  })

  test('binds a cursor to its namespace scope', () => {
    const codec = new V2CursorCodec(SECRET)
    const cursor = codec.encodeRef(NAMESPACE, 'main')

    expectInvalidCursor(() => codec.decodeRef(cursor, 'another-namespace'))
  })

  test('accepts before expiry and rejects exactly at or after expiry', () => {
    let now = 1_000
    const codec = new V2CursorCodec(SECRET, { ttlMs: 10, now: () => now })
    const cursor = codec.encodeRef(NAMESPACE, 'main')

    now = 1_009
    expect(codec.decodeRef(cursor, NAMESPACE)).toBe('main')
    now = 1_010
    expectInvalidCursor(() => codec.decodeRef(cursor, NAMESPACE))
    now = 1_011
    expectInvalidCursor(() => codec.decodeRef(cursor, NAMESPACE))
  })

  test.each([
    '',
    'missing-separator',
    '.',
    'payload.',
    '.signature',
    'a.b.c',
  ])('rejects malformed cursor %j', (cursor) => {
    const codec = new V2CursorCodec(SECRET)

    expectInvalidCursor(() => codec.decodeRef(cursor, NAMESPACE))
  })

  test('rejects payloads larger than the cursor byte budget', () => {
    const codec = new V2CursorCodec(SECRET)
    const oversizedPayload = Buffer.alloc(1025, 'a').toString('base64url')

    expectInvalidCursor(() => codec.decodeRef(`${oversizedPayload}.signature`, NAMESPACE))
    expectInvalidCursor(() => codec.decodeRef(`${'a'.repeat(1537)}.signature`, NAMESPACE))
  })

  test('requires at least 16 secret bytes', () => {
    expect(() => new V2CursorCodec('123456789012345')).toThrowError(
      new TypeError('V2 cursor secret must contain at least 16 bytes'),
    )
    expect(() => new V2CursorCodec(new Uint8Array(15))).toThrow(TypeError)
  })

  test('round-trips recent transform job cursors and binds their scope', () => {
    const codec = new V2CursorCodec(SECRET)
    const state = {
      created_at: '2026-07-25T12:34:56.789Z',
      id: `job_${'a'.repeat(64)}`,
    }
    const cursor = codec.encodeTransformJob(NAMESPACE, state)

    expect(codec.decodeTransformJob(cursor, NAMESPACE)).toEqual(state)
    expect(() => codec.decodeTransformJob(cursor, 'another-namespace')).toThrowError(
      expect.objectContaining({ message: 'Invalid or expired V2 transform job cursor' }),
    )
    expect(() =>
      codec.encodeTransformJob(NAMESPACE, { ...state, created_at: 'not-a-date' }),
    ).toThrow(TypeError)
  })

  test('round-trips Model Registry cursors and binds every list filter', () => {
    const codec = new V2CursorCodec(SECRET)
    const modelState = {
      updated_at: '2026-08-04T12:34:56.789Z',
      id: '11111111-1111-4111-8111-111111111111',
      search: 'qwen',
      archive: 'active',
      source_kind: 'databench_artifact',
      source_mutability: 'immutable',
      verification_level: 'content_verified',
      task_family: 'chat',
      artifact_kind: 'lora_adapter',
      artifact_id: '44444444-4444-4444-8444-444444444444',
      alias: 'candidate',
      deployment_lifecycle: 'active',
      deployment_health: 'healthy',
      tag: 'assistant',
    }
    const modelFilters = {
      search: modelState.search,
      archive: modelState.archive,
      source_kind: modelState.source_kind,
      source_mutability: modelState.source_mutability,
      verification_level: modelState.verification_level,
      task_family: modelState.task_family,
      artifact_kind: modelState.artifact_kind,
      artifact_id: modelState.artifact_id,
      alias: modelState.alias,
      deployment_lifecycle: modelState.deployment_lifecycle,
      deployment_health: modelState.deployment_health,
      tag: modelState.tag,
    }
    const modelCursor = codec.encodeModel(NAMESPACE, modelState)
    expect(codec.decodeModel(modelCursor, NAMESPACE, modelFilters)).toEqual(modelState)
    expect(() =>
      codec.decodeModel(modelCursor, NAMESPACE, { ...modelFilters, search: 'other' }),
    ).toThrowError(expect.objectContaining({ message: 'Invalid or expired V2 Model cursor' }))
    expect(() =>
      codec.decodeModel(modelCursor, NAMESPACE, { ...modelFilters, archive: 'archived' }),
    ).toThrowError(expect.objectContaining({ message: 'Invalid or expired V2 Model cursor' }))
    expect(() =>
      codec.decodeModel(modelCursor, NAMESPACE, { ...modelFilters, source_kind: null }),
    ).toThrowError(expect.objectContaining({ message: 'Invalid or expired V2 Model cursor' }))

    const modelVersionState = {
      created_at: '2026-08-04T12:34:56.789Z',
      id: '22222222-2222-4222-8222-222222222222',
      model_id: modelState.id,
    }
    const modelVersionCursor = codec.encodeModelVersion(NAMESPACE, modelVersionState)
    expect(codec.decodeModelVersion(modelVersionCursor, NAMESPACE, modelState.id)).toEqual(
      modelVersionState,
    )
    expect(() =>
      codec.decodeModelVersion(
        modelVersionCursor,
        NAMESPACE,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).toThrowError(
      expect.objectContaining({ message: 'Invalid or expired V2 Model Version cursor' }),
    )
  })

  test('binds Model Artifact cursors to registered/unregistered filter state', () => {
    const codec = new V2CursorCodec(SECRET)
    const state = {
      created_at: '2026-08-04T12:34:56.789Z',
      id: '44444444-4444-4444-8444-444444444444',
      dataset_version: null,
      artifact_kind: 'lora_adapter',
      registration_status: 'unregistered',
    }
    const cursor = codec.encodeModelArtifact(NAMESPACE, state)
    expect(
      codec.decodeModelArtifact(cursor, NAMESPACE, null, 'lora_adapter', 'unregistered'),
    ).toEqual(state)
    expect(() =>
      codec.decodeModelArtifact(cursor, NAMESPACE, null, 'lora_adapter', 'registered'),
    ).toThrowError(
      expect.objectContaining({ message: 'Invalid or expired V2 Model Artifact cursor' }),
    )
  })

  test('binds Evaluation Deployment cursors to Version and workload admission scope', () => {
    const codec = new V2CursorCodec(SECRET)
    const state = {
      created_at: '2026-08-04T12:34:56.789Z',
      id: '44444444-4444-4444-8444-444444444444',
      model_version_id: '22222222-2222-4222-8222-222222222222',
      workload_profile: 'evalscope_chat_completions_v1',
      max_output_tokens: 4_096,
    }
    const cursor = codec.encodeModelEvaluationDeployment(NAMESPACE, state)

    expect(
      codec.decodeModelEvaluationDeployment(
        cursor,
        NAMESPACE,
        state.model_version_id,
        state.workload_profile,
        state.max_output_tokens,
      ),
    ).toEqual(state)
    for (const [versionId, workloadProfile, maxOutputTokens] of [
      ['33333333-3333-4333-8333-333333333333', state.workload_profile, 4_096],
      [state.model_version_id, 'another-profile', 4_096],
      [state.model_version_id, state.workload_profile, 8_192],
    ] as const) {
      expect(() =>
        codec.decodeModelEvaluationDeployment(
          cursor,
          NAMESPACE,
          versionId,
          workloadProfile,
          maxOutputTokens,
        ),
      ).toThrowError(
        expect.objectContaining({
          message: 'Invalid or expired V2 Model Evaluation Deployment cursor',
        }),
      )
    }
  })

  test('binds historical Deployment adoption cursors to the exact Model Version', () => {
    const codec = new V2CursorCodec(SECRET)
    const state = {
      adopted_at: '2026-08-04T12:34:56.789Z',
      deployment_id: '44444444-4444-4444-8444-444444444444',
      model_version_id: '22222222-2222-4222-8222-222222222222',
    }
    const cursor = codec.encodeModelDeploymentAdoption(NAMESPACE, state)

    expect(codec.decodeModelDeploymentAdoption(cursor, NAMESPACE, state.model_version_id)).toEqual(
      state,
    )
    expect(() =>
      codec.decodeModelDeploymentAdoption(
        cursor,
        NAMESPACE,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).toThrowError(
      expect.objectContaining({
        message: 'Invalid or expired V2 Model Deployment adoption cursor',
      }),
    )
  })

  test('round-trips bounded lineage frontier state and binds all query scope', () => {
    const codec = new V2CursorCodec(SECRET)
    const root = 'a'.repeat(64)
    const state = {
      root_dataset_version: root,
      snapshot_sequence: '1721692800000',
      max_depth: 8,
      max_nodes: 20,
      emitted_nodes: 7,
      emitted_edges: 5,
    }
    const cursor = codec.encodeLineage(NAMESPACE, 'main', state)

    expect(codec.decodeLineage(cursor, NAMESPACE, 'main', 8, 20)).toEqual(state)
    expectInvalidLineageCursor(() =>
      codec.decodeLineage(cursor, 'another-namespace', 'main', 8, 20),
    )
    expectInvalidLineageCursor(() => codec.decodeLineage(cursor, NAMESPACE, 'other', 8, 20))
    expectInvalidLineageCursor(() => codec.decodeLineage(cursor, NAMESPACE, 'main', 7, 20))
    expectInvalidLineageCursor(() => codec.decodeLineage(cursor, NAMESPACE, 'main', 8, 19))
    expect(() =>
      codec.encodeLineage(NAMESPACE, 'main', { ...state, snapshot_sequence: '01' }),
    ).toThrow(TypeError)
    expect(() =>
      codec.encodeLineage(NAMESPACE, 'main', {
        ...state,
        snapshot_sequence: '9223372036854775808',
      }),
    ).toThrow(TypeError)
  })

  test('rejects tampered and expired lineage cursors', () => {
    let now = 100
    const codec = new V2CursorCodec(SECRET, { ttlMs: 10, now: () => now })
    const root = 'c'.repeat(64)
    const cursor = codec.encodeLineage(NAMESPACE, root, {
      root_dataset_version: root,
      snapshot_sequence: '100',
      max_depth: 1,
      max_nodes: 1,
      emitted_nodes: 1,
      emitted_edges: 0,
    })
    const [payload, signature] = cursor.split('.') as [string, string]
    const changed = Buffer.from(signature, 'base64url')
    changed[0] = (changed[0] ?? 0) ^ 1

    expectInvalidLineageCursor(() =>
      codec.decodeLineage(`${payload}.${changed.toString('base64url')}`, NAMESPACE, root, 1, 1),
    )
    now = 110
    expectInvalidLineageCursor(() => codec.decodeLineage(cursor, NAMESPACE, root, 1, 1))
  })
})
