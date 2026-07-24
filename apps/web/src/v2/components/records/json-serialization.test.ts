import { describe, expect, test } from 'vitest'
import { serializeJsonForDisplay } from './json-serialization.js'

describe('worker JSON serialization policy', () => {
  test('previews the exact boundary and downloads one byte above it', () => {
    const initial = serializeJsonForDisplay({ value: 'boundary' }, Number.MAX_SAFE_INTEGER)
    expect(initial.kind).toBe('preview')
    if (initial.kind !== 'preview') throw new Error('expected preview')

    const bytes = new Blob([`${initial.text}\n`]).size
    expect(serializeJsonForDisplay({ value: 'boundary' }, bytes).kind).toBe('preview')
    expect(serializeJsonForDisplay({ value: 'boundary' }, bytes - 1).kind).toBe('download')
  })

  test('fails closed for cyclic values', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(serializeJsonForDisplay(cyclic)).toEqual({ kind: 'error' })
  })
})
