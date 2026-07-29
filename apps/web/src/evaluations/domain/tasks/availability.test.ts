import { describe, expect, test } from 'vitest'
import type { EvaluationRunV2 } from '@/v2/api/types.js'
import { evaluationResultAvailability } from './availability.js'
import { INITIAL_TASK_RUNNER_STATE } from './state.js'

const completed = {
  ...INITIAL_TASK_RUNNER_STATE,
  phase: 'completed' as const,
  taskId: 'eval_11111111-1111-4111-8111-111111111111',
}

describe('evaluation online/archive availability', () => {
  test('distinguishes online available, online unavailable, archive available, and archive failed', () => {
    expect(
      evaluationResultAvailability({ ...completed, documentStatus: 'available' }, run('available')),
    ).toEqual({ online: 'available', archive: 'available' })
    expect(
      evaluationResultAvailability({ ...completed, documentStatus: 'unavailable' }, run('failed')),
    ).toEqual({ online: 'unavailable', archive: 'failed' })
    expect(evaluationResultAvailability(completed, run('uploading'))).toEqual({
      online: 'loading',
      archive: 'processing',
    })
    expect(
      evaluationResultAvailability({ ...completed, documentStatus: 'unavailable' }, null),
    ).toEqual({ online: 'unavailable', archive: 'unavailable' })
  })
})

function run(archiveStatus: EvaluationRunV2['archive_status']): EvaluationRunV2 {
  return { archive_status: archiveStatus } as EvaluationRunV2
}
