import type { output } from 'zod'
import type { generatedDocumentDescriptorSchema, taskTerminalSchema } from '../../api/schemas.js'

export type TaskKind = 'eval' | 'perf'
export type TaskTerminal = output<typeof taskTerminalSchema>
export type TaskDocument = output<typeof generatedDocumentDescriptorSchema>
export type TaskPhase = 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled'

export interface TaskRunnerError {
  readonly code?: string
  readonly field?: string
  readonly message: string
}

export interface TaskRunnerState {
  readonly degradedMessage: string | null
  readonly document: TaskDocument | null
  readonly error: TaskRunnerError | null
  readonly logText: string
  readonly phase: TaskPhase
  readonly progress: number
  readonly resumed: boolean
  readonly tailLine: number
  readonly taskId: string | null
  readonly terminal: TaskTerminal | null
}

export const INITIAL_TASK_RUNNER_STATE: TaskRunnerState = {
  degradedMessage: null,
  document: null,
  error: null,
  logText: '',
  phase: 'idle',
  progress: 0,
  resumed: false,
  tailLine: 0,
  taskId: null,
  terminal: null,
}

const MAX_TASK_LOG_CHARACTERS = 500_000

export type TaskRunnerAction =
  | { readonly resumed: boolean; readonly taskId: string; readonly type: 'start' }
  | { readonly taskId: string; readonly type: 'stopping' }
  | { readonly percent: number; readonly taskId: string; readonly type: 'progress' }
  | {
      readonly tailLine: number
      readonly taskId: string
      readonly text: string
      readonly type: 'log'
    }
  | { readonly message: string | null; readonly taskId: string; readonly type: 'degraded' }
  | { readonly taskId: string; readonly terminal: TaskTerminal; readonly type: 'terminal' }
  | { readonly error: TaskRunnerError; readonly taskId: string; readonly type: 'failed' }
  | { readonly document: TaskDocument; readonly taskId: string; readonly type: 'document' }

export function taskRunnerReducer(
  state: TaskRunnerState,
  action: TaskRunnerAction,
): TaskRunnerState {
  if (action.type === 'start') {
    return {
      ...INITIAL_TASK_RUNNER_STATE,
      phase: 'running',
      resumed: action.resumed,
      taskId: action.taskId,
    }
  }
  if (state.taskId !== action.taskId) return state
  if (isTerminalPhase(state.phase) && action.type !== 'document') return state
  if (action.type === 'stopping') return { ...state, phase: 'stopping' }
  if (action.type === 'progress') {
    return { ...state, progress: Math.max(0, Math.min(100, action.percent)) }
  }
  if (action.type === 'log') {
    if (action.tailLine < state.tailLine) return state
    const appended = action.text === '' ? state.logText : `${state.logText}${action.text}`
    return {
      ...state,
      logText:
        appended.length <= MAX_TASK_LOG_CHARACTERS
          ? appended
          : appended.slice(-MAX_TASK_LOG_CHARACTERS),
      tailLine: action.tailLine,
    }
  }
  if (action.type === 'degraded') return { ...state, degradedMessage: action.message }
  if (action.type === 'failed') {
    return { ...state, error: action.error, phase: 'failed' }
  }
  if (action.type === 'terminal') {
    return {
      ...state,
      degradedMessage: null,
      error:
        action.terminal.error === null
          ? null
          : {
              code: action.terminal.error.code,
              message: action.terminal.error.message,
            },
      phase: action.terminal.status,
      progress: action.terminal.status === 'completed' ? 100 : state.progress,
      terminal: action.terminal,
    }
  }
  return { ...state, document: action.document }
}

export function isTerminalPhase(phase: TaskPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
}
