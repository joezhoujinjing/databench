import { describe, expect, test } from 'vitest'
import { foundationEn, foundationZh } from '../evaluations/i18n/foundation.js'
import { localeDictionaries } from '../evaluations/i18n/translations.js'
import { normalizeLanguage } from './index.js'
import en from './locales/en.json'
import zh from './locales/zh.json'

describe('i18n resources', () => {
  test('keeps en and zh locale key sets identical', () => {
    const enKeys = flattenKeys(en)
    const zhKeys = flattenKeys(zh)

    expect(enKeys).toHaveLength(646)
    expect(zhKeys).toEqual(enKeys)
    expect(enKeys).toEqual(
      expect.arrayContaining([
        'health.connected',
        'health.disconnected',
        'health.checking',
        'v2.datasets.title',
        'v2.transforms.title',
        'v2.transforms.jobs.status.finalizing',
        'v2.export.title',
        'v2.export.previewTitle',
        'v2.export.targetSources.selected-candidate',
        'v2.export.previewTruncated',
        'nav.datasetNavigation',
        'nav.collapseDatasetNavigation',
        'nav.expandDatasetNavigation',
        'nav.datasetList',
        'nav.evaluations',
        'nav.training',
        'training.sameOrigin',
        'training.bearer',
        'training.fullscreenFailed',
        'training.sessionRequired',
        'training.sessionStatus.ready',
        'training.deployments.health.healthy',
      ]),
    )
  })

  test('keeps the complete EvalScope business dictionary aligned under evaluations.*', () => {
    const evaluationEn = { ...localeDictionaries.en, foundation: foundationEn }
    const evaluationZh = { ...localeDictionaries.zh, foundation: foundationZh }
    const enKeys = flattenKeys(evaluationEn)
    const zhKeys = flattenKeys(evaluationZh)

    expect(enKeys.length).toBeGreaterThan(300)
    expect(zhKeys).toEqual(enKeys)
    expect(enKeys).toEqual(
      expect.arrayContaining([
        'nav.dashboard',
        'eval.datasetArgs',
        'prediction.messageLocated',
        'performance.requests',
        'benchmarks.shots',
        'foundation.serviceUnavailable',
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
