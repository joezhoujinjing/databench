import type { EvaluationRunV2 } from '@/v2/api/types.js'
import type { TaskRunnerState } from './state.js'

export type OnlineResultAvailability = 'available' | 'loading' | 'unavailable'
export type ArchiveResultAvailability = 'available' | 'failed' | 'processing' | 'unavailable'

export interface EvaluationResultAvailability {
  readonly online: OnlineResultAvailability
  readonly archive: ArchiveResultAvailability
}

export function evaluationResultAvailability(
  state: TaskRunnerState,
  run: EvaluationRunV2 | null | undefined,
): EvaluationResultAvailability | null {
  if (state.phase !== 'completed') return null
  const online: OnlineResultAvailability =
    state.documentStatus === 'available'
      ? 'available'
      : state.documentStatus === 'unavailable'
        ? 'unavailable'
        : 'loading'
  const archive: ArchiveResultAvailability =
    run?.archive_status === 'available'
      ? 'available'
      : run?.archive_status === 'failed'
        ? 'failed'
        : run === null
          ? 'unavailable'
          : 'processing'
  return { archive, online }
}
