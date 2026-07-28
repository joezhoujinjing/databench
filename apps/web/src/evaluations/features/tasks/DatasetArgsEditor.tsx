import { CodeEditor } from '@/components/ui/code-editor.js'
import { fieldAria, TaskFormField } from './TaskFormField.js'

export function DatasetArgsEditor({
  disabled,
  error,
  id,
  label,
  onChange,
  value,
}: {
  readonly disabled?: boolean | undefined
  readonly error?: string | undefined
  readonly id: string
  readonly label: string
  readonly onChange: (value: string) => void
  readonly value: string
}) {
  return (
    <TaskFormField error={error} id={id} label={label}>
      <CodeEditor
        {...fieldAria(error, id)}
        disabled={disabled}
        id={id}
        maxRows={10}
        minRows={5}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder='{"gsm8k": {"few_shot_num": 4}}'
        value={value}
      />
    </TaskFormField>
  )
}
