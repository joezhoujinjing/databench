import { CapacityExceededError } from '@databench/schema'
import { describe, expect, test } from 'vitest'
import { McpFileTokenRegistry } from '../src/mcp/file-tokens.js'

describe('MCP file token registry', () => {
  test('snapshots metadata and enforces ready to active to deleted single use', () => {
    const registry = createRegistry()
    const metadata = {
      kind: 'process' as const,
      format: 'canonical-jsonl' as const,
      action: 'validate-preview' as const,
      previewRecords: 3,
    }
    const prepared = registry.prepare(metadata)
    metadata.previewRecords = 9

    expect(prepared.token).toMatch(/^proc_[0-9a-f]{64}$/)
    expect(prepared.metadata.previewRecords).toBe(3)
    expect(Object.isFrozen(prepared.metadata)).toBe(true)
    const active = registry.begin(prepared.token, 'process')
    expect(active.busy).toBe(false)
    if (active.busy) throw new Error('expected active token')
    expect(registry.activeCount).toBe(1)
    active.finish()
    active.finish()
    expect(registry.activeCount).toBe(0)
    expect(registry.size).toBe(0)
    expect(() => registry.begin(prepared.token, 'process')).toThrowError(
      'invalid, expired, active, or already used',
    )
  })

  test('keeps a token ready when the global active slot is busy', () => {
    const registry = createRegistry({ maxActive: 1 })
    const first = registry.prepare(importMetadata())
    const second = registry.prepare(importMetadata())
    const firstActive = registry.begin(first.token, 'process')
    if (firstActive.busy) throw new Error('expected first token to be active')

    expect(registry.begin(second.token, 'process')).toEqual({ busy: true })
    expect(registry.size).toBe(2)
    firstActive.finish()

    const secondActive = registry.begin(second.token, 'process')
    expect(secondActive.busy).toBe(false)
    if (!secondActive.busy) secondActive.finish()
    expect(registry.size).toBe(0)
  })

  test('snapshots a canonical draft import digest guard', () => {
    const registry = createRegistry()
    const metadata = {
      kind: 'process' as const,
      format: 'canonical-draft-jsonl-v1' as const,
      action: 'import-dataset' as const,
      expectedInputDigest: 'a'.repeat(64),
    }
    const prepared = registry.prepare(metadata)
    metadata.expectedInputDigest = 'b'.repeat(64)

    const active = registry.begin(prepared.token, 'process')
    if (active.busy) throw new Error('expected active draft import token')
    expect(active.metadata).toEqual({
      kind: 'process',
      format: 'canonical-draft-jsonl-v1',
      action: 'import-dataset',
      expectedInputDigest: 'a'.repeat(64),
    })
    active.finish()
  })

  test('expires ready tokens and sweeps them before applying capacity', () => {
    let now = 1_000
    const registry = createRegistry({ maxEntries: 1, ttlMs: 10, now: () => now })
    const expired = registry.prepare(importMetadata())
    now = 1_010
    expect(() => registry.begin(expired.token, 'process')).toThrowError(
      'invalid, expired, active, or already used',
    )
    expect(registry.size).toBe(0)

    const replacement = registry.prepare(importMetadata())
    expect(replacement.token).not.toBe(expired.token)
    expect(() => registry.prepare(importMetadata())).toThrow(CapacityExceededError)
  })

  test('does not expose whether a token has the wrong operation kind', () => {
    const registry = createRegistry()
    const prepared = registry.prepare({
      kind: 'export',
      datasetVersion: 'a'.repeat(64),
      filename: 'dataset.jsonl',
      mediaType: 'application/x-ndjson',
    })
    expect(() => registry.begin(prepared.token, 'process')).toThrowError(
      'invalid, expired, active, or already used',
    )
    expect(registry.size).toBe(1)
  })
})

function importMetadata() {
  return {
    kind: 'process' as const,
    format: 'canonical-jsonl' as const,
    action: 'import-dataset' as const,
  }
}

function createRegistry(
  overrides: Partial<{
    maxEntries: number
    maxActive: number
    ttlMs: number
    now: () => number
  }> = {},
): McpFileTokenRegistry {
  let value = 0
  return new McpFileTokenRegistry({
    maxEntries: 4,
    maxActive: 2,
    ttlMs: 1_000,
    now: () => 1_000,
    randomBytes32: () => new Uint8Array(32).fill(value++),
    ...overrides,
  })
}
