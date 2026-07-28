import { useCallback, useEffect, useReducer, useRef } from 'react'
import { type EvalScopeClient, evalScopeClient } from '../api/client.js'
import { EvalScopeApiError, isEvalScopeApiError } from '../api/errors.js'
import type { GeneratedDocumentDescriptor } from '../api/schemas.js'
import {
  INITIAL_TASK_RUNNER_STATE,
  isTerminalPhase,
  type TaskKind,
  type TaskRunnerError,
  type TaskRunnerState,
  type TaskTerminal,
  taskRunnerReducer,
} from '../domain/tasks/state.js'

const POLL_INTERVAL_MS = 5_000

export interface TaskRunner {
  readonly start: (payload: Record<string, unknown>) => string | null
  readonly state: TaskRunnerState
  readonly stop: () => Promise<void>
}

export function useTaskRunner({
  client = evalScopeClient,
  initialTaskId,
  kind,
  onTaskIdChange,
  pollIntervalMs = POLL_INTERVAL_MS,
}: {
  readonly client?: EvalScopeClient
  readonly initialTaskId?: string | undefined
  readonly kind: TaskKind
  readonly onTaskIdChange?: ((taskId: string) => void) | undefined
  readonly pollIntervalMs?: number | undefined
}): TaskRunner {
  const [state, dispatch] = useReducer(taskRunnerReducer, INITIAL_TASK_RUNNER_STATE)
  const activeTaskRef = useRef<string | null>(null)
  const invocationRef = useRef<AbortController | null>(null)
  const pollingRef = useRef<AbortController | null>(null)
  const pollingTimerRef = useRef<number | null>(null)
  const submissionLockedRef = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const clearPollingTimer = useCallback(() => {
    if (pollingTimerRef.current !== null) window.clearTimeout(pollingTimerRef.current)
    pollingTimerRef.current = null
  }, [])

  const abortActiveRequests = useCallback(() => {
    invocationRef.current?.abort()
    pollingRef.current?.abort()
    invocationRef.current = null
    pollingRef.current = null
    clearPollingTimer()
  }, [clearPollingTimer])

  const requestDocument = useCallback(
    async (taskId: string, signal?: AbortSignal) => {
      dispatch({ taskId, type: 'document-loading' })
      try {
        const document = await client.request(kind === 'eval' ? 'evalReport' : 'perfReport', {
          query: { task_id: taskId },
          ...(signal === undefined ? {} : { signal }),
        })
        if (activeTaskRef.current === taskId) dispatch({ document, taskId, type: 'document' })
      } catch (error) {
        if (!isAbort(error) && activeTaskRef.current === taskId) {
          dispatch({ taskId, type: 'document-unavailable' })
          dispatch({ message: errorMessage(error), taskId, type: 'degraded' })
        }
      }
    },
    [client, kind],
  )

  const settleTerminal = useCallback(
    (taskId: string, terminal: TaskTerminal) => {
      if (activeTaskRef.current !== taskId || isTerminalPhase(stateRef.current.phase)) return
      submissionLockedRef.current = false
      dispatch({ taskId, terminal, type: 'terminal' })
      pollingRef.current?.abort()
      pollingRef.current = null
      clearPollingTimer()
      if (terminal.status === 'completed') void requestDocument(taskId)
    },
    [clearPollingTimer, requestDocument],
  )

  const pollTask = useCallback(
    (taskId: string, controller: AbortController) => {
      const poll = async () => {
        if (controller.signal.aborted || activeTaskRef.current !== taskId) return
        const tailLine = stateRef.current.taskId === taskId ? stateRef.current.tailLine : 0
        const [progress, log] = await Promise.allSettled([
          client.request(kind === 'eval' ? 'evalProgress' : 'perfProgress', {
            query: { task_id: taskId },
            signal: controller.signal,
          }),
          client.request(kind === 'eval' ? 'evalLog' : 'perfLog', {
            query: { start_line: tailLine, task_id: taskId },
            signal: controller.signal,
          }),
        ])
        if (controller.signal.aborted || activeTaskRef.current !== taskId) return
        let degraded: string | null = null
        if (progress.status === 'fulfilled') {
          dispatch({ percent: progress.value.percent, taskId, type: 'progress' })
          if (progress.value.terminal !== undefined) {
            settleTerminal(taskId, progress.value.terminal)
            return
          }
        } else if (!isAbort(progress.reason)) {
          degraded = errorMessage(progress.reason)
        }
        if (log.status === 'fulfilled') {
          dispatch({
            tailLine: log.value.tail_line,
            taskId,
            text: log.value.text,
            type: 'log',
          })
        } else if (!isAbort(log.reason)) {
          degraded ??= errorMessage(log.reason)
        }
        dispatch({ message: degraded, taskId, type: 'degraded' })
        if (!controller.signal.aborted && activeTaskRef.current === taskId) {
          pollingTimerRef.current = window.setTimeout(poll, pollIntervalMs)
        }
      }
      void poll()
    },
    [client, kind, pollIntervalMs, settleTerminal],
  )

  const startPolling = useCallback(
    (taskId: string) => {
      pollingRef.current?.abort()
      clearPollingTimer()
      const controller = new AbortController()
      pollingRef.current = controller
      pollTask(taskId, controller)
    },
    [clearPollingTimer, pollTask],
  )

  const failTask = useCallback(
    (taskId: string, error: unknown) => {
      if (activeTaskRef.current !== taskId || isAbort(error)) return
      if (
        isEvalScopeApiError(error) &&
        (error.kind === 'network' || error.kind === 'unavailable')
      ) {
        dispatch({ message: error.message, taskId, type: 'degraded' })
        return
      }
      submissionLockedRef.current = false
      const taskError: TaskRunnerError = {
        ...(isEvalScopeApiError(error) && error.code !== undefined ? { code: error.code } : {}),
        ...(isEvalScopeApiError(error) && error.field !== undefined ? { field: error.field } : {}),
        message: errorMessage(error),
      }
      dispatch({ error: taskError, taskId, type: 'failed' })
      pollingRef.current?.abort()
      clearPollingTimer()
    },
    [clearPollingTimer],
  )

  const start = useCallback(
    (payload: Record<string, unknown>): string | null => {
      if (submissionLockedRef.current) return null
      submissionLockedRef.current = true
      abortActiveRequests()
      const taskId = `${kind}_${crypto.randomUUID()}`
      activeTaskRef.current = taskId
      dispatch({ resumed: false, taskId, type: 'start' })
      onTaskIdChange?.(taskId)
      startPolling(taskId)
      const controller = new AbortController()
      invocationRef.current = controller
      void client
        .request(kind === 'eval' ? 'evalInvoke' : 'perfInvoke', {
          body: payload,
          signal: controller.signal,
          taskId,
        })
        .then((response) => {
          if (activeTaskRef.current !== taskId) return
          if (response.terminal !== undefined) {
            settleTerminal(taskId, response.terminal)
          } else if (response.status === 'error' || response.status === 'stopped') {
            failTask(
              taskId,
              new EvalScopeApiError('http-5xx', response.error ?? 'EvalScope task failed'),
            )
          }
        })
        .catch((error: unknown) => failTask(taskId, error))
        .finally(() => {
          if (invocationRef.current === controller) invocationRef.current = null
        })
      return taskId
    },
    [abortActiveRequests, client, failTask, kind, onTaskIdChange, settleTerminal, startPolling],
  )

  const stop = useCallback(async () => {
    const taskId = activeTaskRef.current
    if (
      taskId === null ||
      !submissionLockedRef.current ||
      isTerminalPhase(stateRef.current.phase)
    ) {
      return
    }
    dispatch({ taskId, type: 'stopping' })
    invocationRef.current?.abort()
    pollingRef.current?.abort()
    clearPollingTimer()
    const controller = new AbortController()
    try {
      const response = await client.request(kind === 'eval' ? 'evalStop' : 'perfStop', {
        query: { task_id: taskId },
        signal: controller.signal,
      })
      if (response.terminal !== undefined) settleTerminal(taskId, response.terminal)
      else startPolling(taskId)
    } catch (error) {
      if (!isAbort(error) && activeTaskRef.current === taskId) {
        dispatch({ message: errorMessage(error), taskId, type: 'degraded' })
        startPolling(taskId)
      }
    }
  }, [clearPollingTimer, client, kind, settleTerminal, startPolling])

  useEffect(() => {
    if (
      initialTaskId === undefined ||
      activeTaskRef.current !== null ||
      !validTaskId(kind, initialTaskId)
    ) {
      return
    }
    submissionLockedRef.current = true
    activeTaskRef.current = initialTaskId
    dispatch({ resumed: true, taskId: initialTaskId, type: 'start' })
    startPolling(initialTaskId)
  }, [initialTaskId, kind, startPolling])

  useEffect(
    () => () => {
      activeTaskRef.current = null
      submissionLockedRef.current = false
      abortActiveRequests()
    },
    [abortActiveRequests],
  )

  return { start, state, stop }
}

function validTaskId(kind: TaskKind, taskId: string): boolean {
  return new RegExp(
    `^${kind}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    'u',
  ).test(taskId)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'EvalScope request failed'
}

function isAbort(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError') ||
    (isEvalScopeApiError(error) && error.kind === 'aborted')
  )
}

export function taskViewerHref(document: GeneratedDocumentDescriptor): string {
  return `/evaluations/viewer?${new URLSearchParams({ document: document.document_id })}`
}
