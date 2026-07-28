import { SwiftStudioSessionStateConflictErrorV2 } from '@databench/schema'
import { describe, expect, test, vi } from 'vitest'
import type { ApiV2Workspace } from '../src/context.js'
import { createTestApp } from './test-app.js'

const SESSION_ID = '32d43a6e-939b-47da-b516-29a0f43ca474'
const VERSION = 'a'.repeat(64)

function session(status: 'ready' | 'closed' = 'ready') {
  return {
    id: SESSION_ID,
    create_digest: 'b'.repeat(64),
    status,
    dataset_version: VERSION,
    display_ref: 'training-main',
    converter: 'ms-swift' as const,
    converter_version: '1.0.0' as const,
    normalized_options: {},
    fidelity_digest: 'c'.repeat(64),
    output_count: 1,
    export_digest: 'd'.repeat(64),
    export_size_bytes: 128,
    provider: 'swift-studio' as const,
    upstream_commit: 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d',
    image_digest: 'e'.repeat(64),
    runtime_capability_digest: 'f'.repeat(64),
    failure: null,
    studio_path: status === 'ready' ? ('/swift-studio/' as const) : null,
    created_at: '2026-07-28T00:00:00.000Z',
    ready_at: '2026-07-28T00:00:01.000Z',
    closed_at: status === 'closed' ? '2026-07-28T00:00:02.000Z' : null,
    updated_at: status === 'closed' ? '2026-07-28T00:00:02.000Z' : '2026-07-28T00:00:01.000Z',
  }
}

function workspace(overrides: Partial<ApiV2Workspace> = {}): ApiV2Workspace {
  return {
    createSwiftStudioSession: vi.fn(async () => session()),
    getSwiftStudioSession: vi.fn(async () => session()),
    listSwiftStudioSessions: vi.fn(async () => ({ items: [session()], next_cursor: null })),
    closeSwiftStudioSession: vi.fn(async () => session('closed')),
    ...overrides,
  } as unknown as ApiV2Workspace
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init)
}

describe('Swift Studio Session HTTP contract', () => {
  test('creates, lists, gets, and closes a Session through Workspace only', async () => {
    const fake = workspace()
    const app = createTestApp({ v2Workspace: fake })
    const createBody = {
      dataset_version: VERSION,
      display_ref: 'training-main',
      converter: 'ms-swift',
      options: {},
      accepted_fidelity_digest: 'c'.repeat(64),
    }
    const created = await app.fetch(
      request('/v2/swift-studio-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      }),
    )
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual(session())
    expect(fake.createSwiftStudioSession).toHaveBeenCalledWith(
      createBody,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const listed = await app.fetch(request('/v2/swift-studio-sessions?limit=20'))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ items: [session()], next_cursor: null })

    const shown = await app.fetch(request(`/v2/swift-studio-sessions/${SESSION_ID}`))
    expect(shown.status).toBe(200)
    expect(await shown.json()).toEqual(session())

    const closed = await app.fetch(
      request(`/v2/swift-studio-sessions/${SESSION_ID}:close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )
    expect(closed.status).toBe(200)
    expect(await closed.json()).toEqual(session('closed'))
  })

  test('maps singleton conflicts to the exact typed 409 envelope', async () => {
    const fake = workspace({
      createSwiftStudioSession: vi.fn(async () => {
        throw new SwiftStudioSessionStateConflictErrorV2({
          reason: 'active_session_exists',
          session_id: SESSION_ID,
          status: 'ready',
          requested_status: null,
        })
      }),
    })
    const response = await createTestApp({ v2Workspace: fake }).fetch(
      request('/v2/swift-studio-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_version: VERSION,
          display_ref: null,
          converter: 'ms-swift',
          options: {},
          accepted_fidelity_digest: 'c'.repeat(64),
        }),
      }),
    )
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(409)
    expect(body).toMatchObject({
      error: {
        code: 'swift_studio_session_state_conflict',
        detail: { reason: 'active_session_exists', session_id: SESSION_ID },
      },
    })
  })

  test('maps a busy Provider close to 409 without replacing the ready Session', async () => {
    const fake = workspace({
      closeSwiftStudioSession: vi.fn(async () => {
        throw new SwiftStudioSessionStateConflictErrorV2({
          reason: 'provider_session_busy',
          session_id: SESSION_ID,
          status: 'ready',
          requested_status: 'closing',
        })
      }),
    })
    const response = await createTestApp({ v2Workspace: fake }).fetch(
      request(`/v2/swift-studio-sessions/${SESSION_ID}:close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'swift_studio_session_state_conflict',
        detail: {
          reason: 'provider_session_busy',
          session_id: SESSION_ID,
          status: 'ready',
          requested_status: 'closing',
        },
      },
    })
    expect(fake.getSwiftStudioSession).not.toHaveBeenCalled()
  })
})
