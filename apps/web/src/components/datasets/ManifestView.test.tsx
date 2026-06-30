import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test } from 'vitest'
import type { DatasetManifest } from '@/api/types.js'
import i18n from '@/i18n/index.js'
import { ManifestView } from './ManifestView.js'

describe('ManifestView', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  test('renders core manifest fields, kind counts, and extra fields', () => {
    const html = renderToStaticMarkup(<ManifestView manifest={manifest()} />)

    expect(html).toContain('abc123')
    expect(html).toContain('demo')
    expect(html).toContain('sft: 2')
    expect(html).toContain('Other manifest fields')
    expect(html).toContain('schema_version')
  })
})

function manifest(): DatasetManifest {
  return {
    columns: ['id', 'kind'],
    created_at: '2026-06-30T00:00:00Z',
    hash_algo: 'blake3',
    kinds: { preference: 0, sft: 2 },
    name: 'demo',
    num_rows: 2,
    schema_version: '1',
    version: 'abc123',
  }
}
