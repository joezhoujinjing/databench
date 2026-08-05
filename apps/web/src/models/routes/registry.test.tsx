import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n/index.js'
import type { ModelPageV2 } from '@/models/api/registry.js'
import { candidateExpectedVersionIdV2, ModelRegistryResults } from './registry.js'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    params,
    to,
  }: {
    readonly children: ReactNode
    readonly className?: string
    readonly params: { readonly modelId: string }
    readonly to: string
  }) => (
    <a className={className} href={to.replace('$modelId', params.modelId)}>
      {children}
    </a>
  ),
  useSearch: () => ({}),
}))

const modelId = '123e4567-e89b-42d3-a456-426614174010'
const page: ModelPageV2 = {
  items: [
    {
      active_adopted_deployment_count: 1,
      adopted_deployment_count: 2,
      deployment_summary: {
        total: 1,
        registered: 0,
        active: 1,
        disabled: 0,
        healthy_active: 1,
      },
      candidate: {
        base_model_reference: 'Qwen/Qwen2.5-7B-Instruct',
        source_kind: 'databench_artifact',
        source_mutability: 'immutable',
        verification_level: 'content_verified',
        version_id: '123e4567-e89b-42d3-a456-426614174011',
        version_label: 'r2',
      },
      healthy_adopted_deployment_count: 1,
      latest_comparable_evaluation: null,
      model: {
        archived_at: null,
        created_at: '2026-08-04T01:00:00.000Z',
        description: 'Support model',
        display_name: 'Support Model',
        id: modelId,
        key: 'support-model',
        metadata_revision: 1,
        tags: ['support'],
        task_family: 'chat',
        updated_at: '2026-08-04T02:00:00.000Z',
      },
      version_count: 3,
    },
  ],
  next_cursor: null,
}

describe('Model Registry responsive results', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  test('renders a desktop table and a mobile semantic summary for the same Model', () => {
    const html = renderToStaticMarkup(<ModelRegistryResults page={page} />)

    expect(html).toContain('aria-label="Model registry"')
    expect(html).toContain(
      'class="w-full overflow-x-auto rounded-[5px] border border-border hidden sm:block"',
    )
    expect(html).toContain('<table')
    expect(html).toContain('aria-label="Model registry summary"')
    expect(html).toContain('class="sm:hidden"')
    expect(html).toContain('<ol')
    expect(html).toContain('<dl')
    expect(html).toContain('<dt class="text-muted-foreground">Candidate</dt>')
    expect(html).toContain('<dt class="text-muted-foreground">Source</dt>')
    expect(html).toContain('<dt class="text-muted-foreground">Base model</dt>')
    expect(html).toContain('<dt class="text-muted-foreground">Deployments / health</dt>')
    expect(html).toContain('<dt class="text-muted-foreground">Updated</dt>')
    expect(html.match(new RegExp(`/models/${modelId}`, 'gu'))).toHaveLength(2)
    expect(html.match(/Support Model/gu)).toHaveLength(2)
  })

  test('uses the current candidate Version as the existing-Model Alias CAS baseline', () => {
    expect(candidateExpectedVersionIdV2(page.items, 'create_model', modelId)).toBeNull()
    expect(candidateExpectedVersionIdV2(page.items, 'existing_model', modelId)).toBe(
      page.items[0]?.candidate?.version_id,
    )
    expect(
      candidateExpectedVersionIdV2(
        page.items,
        'existing_model',
        '123e4567-e89b-42d3-a456-426614174099',
      ),
    ).toBeNull()
  })

  test('keeps registration targets independent from the visible registry filters', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, 'registry.tsx'), 'utf8')

    expect(source).toContain("'models', 'registration-targets'")
    expect(source).toContain('models={registrationModels}')
    expect(source).not.toContain('models={modelsQuery.data}')
  })
})
