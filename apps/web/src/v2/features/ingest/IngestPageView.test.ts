import { describe, expect, test } from 'vitest'
import { canonicalJsonArrayToJsonl } from './IngestPageView.js'

describe('canonical JSON array creation', () => {
  test('requires a JSON array', () => {
    expect(canonicalJsonArrayToJsonl('{"schema_version":"2.0.0"}')).toEqual({
      ok: false,
      reason: 'not_array',
    })
  })

  test('surfaces malformed JSON', () => {
    expect(canonicalJsonArrayToJsonl('[{')).toMatchObject({
      ok: false,
      reason: 'invalid_json',
    })
  })

  test('preserves each raw record for strict server-side validation', () => {
    const input = `[
      {"id":"rec_1","extra":{"duplicate":1,"duplicate":2}},
      {"id":"rec_2","contents":[{"text":"comma, bracket ] and escaped \\" quote"}]}
    ]`

    expect(canonicalJsonArrayToJsonl(input)).toEqual({
      ok: true,
      jsonl:
        '{"id":"rec_1","extra":{"duplicate":1,"duplicate":2}}\n' +
        '{"id":"rec_2","contents":[{"text":"comma, bracket ] and escaped \\" quote"}]}\n',
    })
  })

  test('converts an empty array to an empty JSONL body', () => {
    expect(canonicalJsonArrayToJsonl(' [ ] \n')).toEqual({ ok: true, jsonl: '' })
  })
})
