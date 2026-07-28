import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/ui/field.js'

export function TaskFormField({
  children,
  error,
  hint,
  id,
  label,
  required = false,
}: {
  readonly children: ReactNode
  readonly error?: string | undefined
  readonly hint?: ReactNode | undefined
  readonly id: string
  readonly label: ReactNode
  readonly required?: boolean
}) {
  const { t } = useTranslation()
  const errorId = `${id}-error`
  const errorText = error?.startsWith('evaluations.') ? t(error) : error
  return (
    <Field
      hint={
        <>
          {hint}
          {errorText === undefined ? null : (
            <span className="block text-danger" id={errorId} role="alert">
              {errorText}
            </span>
          )}
        </>
      }
      htmlFor={id}
      label={
        <>
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </>
      }
    >
      {children}
    </Field>
  )
}

export function fieldAria(error: string | undefined, id: string) {
  return {
    'aria-describedby': error === undefined ? undefined : `${id}-error`,
    'aria-invalid': error === undefined ? undefined : true,
  } as const
}
