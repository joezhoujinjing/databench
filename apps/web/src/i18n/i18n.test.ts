import { describe, expect, test } from 'vitest'
import { normalizeLanguage } from './index.js'
import en from './locales/en.json'
import zh from './locales/zh.json'

describe('i18n resources', () => {
  test('keeps en and zh locale key sets identical', () => {
    const enKeys = flattenKeys(en)
    const zhKeys = flattenKeys(zh)

    expect(enKeys).toHaveLength(221)
    expect(zhKeys).toEqual(enKeys)
    expect(enKeys).toEqual(
      expect.arrayContaining([
        'health.connected',
        'health.disconnected',
        'health.checking',
        'vocab.status.draft',
        'vocab.status.curated',
      ]),
    )
  })

  test('normalizes supported browser-style language tags without using browser locale detection', () => {
    expect(normalizeLanguage('zh-CN')).toBe('zh')
    expect(normalizeLanguage('en-US')).toBe('en')
    expect(normalizeLanguage('fr-FR')).toBeUndefined()
  })
})

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenKeys(child, prefix === '' ? key : `${prefix}.${key}`),
    )
  }

  return [prefix]
}
