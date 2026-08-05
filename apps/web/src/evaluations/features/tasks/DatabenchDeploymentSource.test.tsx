import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test } from 'vitest'
import { registerEvaluationTranslations } from '@/evaluations/i18n/register.js'
import i18n from '@/i18n/index.js'
import type { ModelEvaluationDeploymentSelectorV2 } from '@/models/api/registry.js'
import {
  DatabenchDeploymentCandidateOptions,
  shouldClearMissingPaginatedSelection,
} from './DatabenchDeploymentSource.js'

const versionId = '123e4567-e89b-42d3-a456-426614174011'
const eligibleId = '123e4567-e89b-42d3-a456-426614174012'
const excludedId = '123e4567-e89b-42d3-a456-426614174013'
const now = '2026-08-04T12:00:00.000Z'

const candidates: ModelEvaluationDeploymentSelectorV2['items'] = [
  {
    deployment: {
      id: eligibleId,
      model_version_id: versionId,
      display_name: 'Evaluation service',
      provider: 'openai_compatible',
      served_model_name: 'qwen-r1',
      connectivity_scope: 'private_network',
      auth_profile: 'none',
      declared_capabilities: { interfaces: ['chat_completions'], context_limit: 32_768 },
      lifecycle: 'active',
      availability: 'available',
      unavailable_reason: null,
      health_status: 'healthy',
      health_checked_at: now,
      health_error_code: null,
      created_at: now,
      activated_at: now,
      disabled_at: null,
      updated_at: now,
    },
    eligible: true,
    exclusion_reasons: [],
  },
  {
    deployment: {
      id: excludedId,
      model_version_id: versionId,
      display_name: 'Disabled embedding service',
      provider: 'openai_compatible',
      served_model_name: 'embedding-r1',
      connectivity_scope: 'private_network',
      auth_profile: 'none',
      declared_capabilities: { interfaces: ['embeddings'], context_limit: 1_024 },
      lifecycle: 'disabled',
      availability: 'unavailable',
      unavailable_reason: 'not_active',
      health_status: 'unhealthy',
      health_checked_at: now,
      health_error_code: 'unhealthy',
      created_at: now,
      activated_at: now,
      disabled_at: now,
      updated_at: now,
    },
    eligible: false,
    exclusion_reasons: [
      'not_active',
      'unavailable',
      'interface_missing',
      'context_limit_insufficient',
    ],
  },
]

describe('Evaluation Model Deployment selector', () => {
  beforeAll(async () => {
    registerEvaluationTranslations()
    await i18n.changeLanguage('en')
  })

  test('keeps eligible Deployments selectable and explains every excluded candidate', () => {
    const html = renderToStaticMarkup(
      <DatabenchDeploymentCandidateOptions
        candidates={candidates}
        deploymentId={eligibleId}
        disabled={false}
        onChange={() => undefined}
      />,
    )

    expect(html.match(/type="radio"/gu)).toHaveLength(2)
    expect(html).toMatch(
      new RegExp(
        `<input[^>]*name="evaluation-deployment"[^>]*checked=""[^>]*value="${eligibleId}"`,
        'u',
      ),
    )
    expect(html).toMatch(new RegExp(`<input[^>]*disabled=""[^>]*value="${excludedId}"`, 'u'))
    for (const reason of candidates[1]?.exclusion_reasons ?? []) {
      expect(html).toContain(i18n.t(`evaluations.tasks.selectorExclusions.${reason}`))
    }
  })

  test('preserves a selected item until every scoped selector page has been loaded', () => {
    expect(shouldClearMissingPaginatedSelection(true, false, true, true)).toBe(false)
    expect(shouldClearMissingPaginatedSelection(true, false, false, false)).toBe(false)
    expect(shouldClearMissingPaginatedSelection(true, true, false, true)).toBe(false)
    expect(shouldClearMissingPaginatedSelection(true, false, false, true)).toBe(true)
  })
})
