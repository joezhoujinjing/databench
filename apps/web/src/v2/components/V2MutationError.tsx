import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/errors.js'
import { Alert } from '@/components/ui/alert.js'

export function V2MutationError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  const issues = validationIssues(error)
  const alertRef = useRef<HTMLDivElement>(null)
  useEffect(() => alertRef.current?.focus(), [])

  return (
    <Alert
      className="border-danger/35 bg-danger/10 text-danger"
      ref={alertRef}
      role="alert"
      tabIndex={-1}
    >
      <div className="font-medium">
        {error instanceof Error ? error.message : t('v2.common.unknownError')}
      </div>
      {issues.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.code}:${issue.line ?? ''}`}>
              <code>{issue.path}</code>: {issue.message}
              {issue.line === null ? null : ` (${t('v2.common.line', { line: issue.line })})`}
            </li>
          ))}
        </ul>
      ) : null}
    </Alert>
  )
}

export function validationIssues(
  error: unknown,
): Array<{ code: string; line: number | null; message: string; path: string }> {
  if (!(error instanceof ApiError) || !isRecord(error.detail)) return []
  const issues = error.detail.issues
  if (!Array.isArray(issues)) return []

  return issues.flatMap((issue) => {
    if (
      !isRecord(issue) ||
      typeof issue.code !== 'string' ||
      typeof issue.message !== 'string' ||
      typeof issue.path !== 'string' ||
      (issue.line !== null && typeof issue.line !== 'number')
    ) {
      return []
    }
    return [
      {
        code: issue.code,
        line: issue.line,
        message: issue.message,
        path: issue.path,
      },
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
