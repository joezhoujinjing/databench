import { describe, expect, test } from 'vitest'
import {
  CreateSwiftStudioSessionRequestV2Schema,
  SwiftStudioSessionPageRequestV2Schema,
  SwiftStudioSessionStateConflictErrorV2,
  SwiftStudioSessionV2Schema,
} from '../src/index.js'

const VERSION = 'a'.repeat(64)
const DIGEST = 'b'.repeat(64)
const NOW = '2026-07-28T00:00:00.000Z'

function createRequest() {
  return {
    dataset_version: VERSION,
    display_ref: 'main',
    converter: 'ms-swift',
    options: {},
    accepted_fidelity_digest: DIGEST,
  }
}

function session() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    create_digest: DIGEST,
    status: 'preparing',
    dataset_version: VERSION,
    display_ref: 'main',
    converter: 'ms-swift',
    converter_version: '1.0.0',
    normalized_options: {},
    fidelity_digest: 'c'.repeat(64),
    output_count: 4,
    export_digest: null,
    export_size_bytes: null,
    provider: 'swift-studio',
    upstream_commit: 'd'.repeat(40),
    image_digest: 'e'.repeat(64),
    runtime_capability_digest: 'f'.repeat(64),
    failure: null,
    studio_path: null,
    created_at: NOW,
    ready_at: null,
    closed_at: null,
    updated_at: NOW,
  }
}

describe('V2 Swift Studio Session contracts', () => {
  test('accepts only exact Dataset-bound ms-swift create requests', () => {
    expect(CreateSwiftStudioSessionRequestV2Schema.parse(createRequest())).toEqual(createRequest())
    for (const invalid of [
      { ...createRequest(), dataset_version: 'main' },
      { ...createRequest(), display_ref: VERSION },
      { ...createRequest(), converter: 'trl-sft' },
      { ...createRequest(), accepted_fidelity_digest: 'invalid' },
      { ...createRequest(), unknown: true },
    ]) {
      expect(CreateSwiftStudioSessionRequestV2Schema.safeParse(invalid).success).toBe(false)
    }
  })

  test('enforces preparing, ready, closing, closed, and failed response shapes', () => {
    const preparing = session()
    expect(SwiftStudioSessionV2Schema.parse(preparing)).toEqual(preparing)
    const ready = {
      ...preparing,
      status: 'ready',
      export_digest: '1'.repeat(64),
      export_size_bytes: 256,
      ready_at: NOW,
      studio_path: '/swift-studio/',
    }
    expect(SwiftStudioSessionV2Schema.parse(ready)).toEqual(ready)
    expect(SwiftStudioSessionV2Schema.safeParse({ ...ready, export_digest: null }).success).toBe(
      false,
    )
    expect(
      SwiftStudioSessionV2Schema.safeParse({ ...ready, studio_path: 'http://provider:7860' })
        .success,
    ).toBe(false)
    expect(
      SwiftStudioSessionV2Schema.safeParse({
        ...preparing,
        status: 'failed',
        failure: { phase: 'provider', code: 'prepare_failed', message: 'token=secret-value' },
      }).success,
    ).toBe(false)
  })

  test('uses strict bounded list filters and typed state-conflict detail', () => {
    expect(SwiftStudioSessionPageRequestV2Schema.parse({})).toEqual({ cursor: null, limit: 20 })
    expect(
      SwiftStudioSessionPageRequestV2Schema.parse({
        dataset_version: VERSION,
        status: 'ready',
        cursor: '',
        limit: '100',
      }),
    ).toEqual({ dataset_version: VERSION, status: 'ready', cursor: null, limit: 100 })

    const error = new SwiftStudioSessionStateConflictErrorV2({
      reason: 'active_session_exists',
      session_id: session().id,
      status: 'ready',
      requested_status: null,
    })
    expect(error.code).toBe('swift_studio_session_state_conflict')
    expect(error.detail).toMatchObject({ reason: 'active_session_exists' })
  })
})
