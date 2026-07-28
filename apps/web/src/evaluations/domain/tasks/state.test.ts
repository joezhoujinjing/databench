import { describe, expect, it } from 'vitest'
import { INITIAL_TASK_RUNNER_STATE, taskRunnerReducer } from './state.js'

const taskId = 'eval_123e4567-e89b-42d3-a456-426614174000'

describe('task runner state', () => {
  it('keeps last progress and log while polling is degraded', () => {
    let state = taskRunnerReducer(INITIAL_TASK_RUNNER_STATE, {
      resumed: false,
      taskId,
      type: 'start',
    })
    state = taskRunnerReducer(state, { percent: 42, taskId, type: 'progress' })
    state = taskRunnerReducer(state, { tailLine: 2, taskId, text: 'hello\n', type: 'log' })
    state = taskRunnerReducer(state, { message: 'network unavailable', taskId, type: 'degraded' })
    expect(state).toMatchObject({
      degradedMessage: 'network unavailable',
      logText: 'hello\n',
      phase: 'running',
      progress: 42,
      tailLine: 2,
    })
  })

  it('accepts only the first terminal outcome in a stop/failure race', () => {
    const running = taskRunnerReducer(INITIAL_TASK_RUNNER_STATE, {
      resumed: false,
      taskId,
      type: 'start',
    })
    const cancelled = taskRunnerReducer(running, {
      taskId,
      terminal: {
        error: { code: 'user_cancelled', message: 'Task was cancelled', phase: 'provider_stop' },
        metrics: null,
        provider_report_ids: null,
        status: 'cancelled',
      },
      type: 'terminal',
    })
    const raced = taskRunnerReducer(cancelled, {
      error: { code: 'provider_failed', message: 'late failure' },
      taskId,
      type: 'failed',
    })
    expect(raced.phase).toBe('cancelled')
    expect(raced.error?.code).toBe('user_cancelled')
  })

  it('ignores updates from a superseded task', () => {
    const state = taskRunnerReducer(INITIAL_TASK_RUNNER_STATE, {
      resumed: false,
      taskId,
      type: 'start',
    })
    expect(
      taskRunnerReducer(state, {
        percent: 99,
        taskId: 'eval_123e4567-e89b-42d3-a456-426614174999',
        type: 'progress',
      }),
    ).toBe(state)
  })
})
