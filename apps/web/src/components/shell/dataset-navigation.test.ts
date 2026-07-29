import { describe, expect, test } from 'vitest'
import { datasetNavigationSection } from './dataset-navigation.js'

describe('datasetNavigationSection', () => {
  test.each([
    ['/datasets', 'datasets'],
    ['/datasets/customer-support', 'datasets'],
    ['/datasets/customer-support/records/record-1', 'datasets'],
    ['/lineage/customer-support', 'datasets'],
    ['/export/customer-support', 'datasets'],
    ['/ingest', 'ingest'],
    ['/transforms', 'transforms'],
  ] as const)('maps %s to the %s dataset section', (pathname, section) => {
    expect(datasetNavigationSection(pathname)).toBe(section)
  })

  test.each([
    '/',
    '/evaluations',
    '/evaluations/tasks',
    '/training',
    '/unknown',
  ])('keeps %s outside the dataset workspace', (pathname) => {
    expect(datasetNavigationSection(pathname)).toBeNull()
  })
})
