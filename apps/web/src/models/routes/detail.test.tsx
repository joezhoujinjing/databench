import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n/index.js'
import { MODEL_DETAIL_TABS, ModelDetailNavigation } from './detail.js'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    'aria-current': ariaCurrent,
    children,
    className,
    params,
    search,
    to,
  }: {
    readonly 'aria-current'?: 'page'
    readonly children: ReactNode
    readonly className?: string
    readonly params: { readonly modelId: string }
    readonly search: { readonly tab: string; readonly version?: string }
    readonly to: string
  }) => {
    const query = new URLSearchParams(search).toString()
    return (
      <a
        aria-current={ariaCurrent}
        className={className}
        href={`${to.replace('$modelId', params.modelId)}?${query}`}
      >
        {children}
      </a>
    )
  },
  useParams: () => ({ modelId: '' }),
  useSearch: () => ({}),
}))

describe('Model detail navigation', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  test('renders all six direct-refresh tabs with exact Model and Version context', () => {
    const modelId = '123e4567-e89b-42d3-a456-426614174010'
    const versionId = '123e4567-e89b-42d3-a456-426614174011'
    const html = renderToStaticMarkup(
      <ModelDetailNavigation activeTab="lineage" modelId={modelId} selectedVersionId={versionId} />,
    )

    expect(MODEL_DETAIL_TABS.map(({ id }) => id)).toEqual([
      'overview',
      'versions',
      'artifacts',
      'evaluations',
      'deployments',
      'lineage',
    ])
    expect(html.match(/<a /gu)).toHaveLength(6)
    expect(html.match(/aria-current="page"/gu)).toHaveLength(1)
    for (const { id } of MODEL_DETAIL_TABS) {
      expect(html).toContain(`/models/${modelId}?tab=${id}&amp;version=${versionId}`)
      expect(html).toContain(i18n.t(`models.tabs.${id}`))
    }
  })
})
