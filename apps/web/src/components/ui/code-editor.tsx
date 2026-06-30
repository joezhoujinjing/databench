import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils.js'

export interface CodeEditorProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'children'> {
  readonly header?: ReactNode
  readonly language?: string
  readonly maxRows?: number
  readonly minRows?: number
  readonly textareaClassName?: string
}

export function CodeEditor({
  className,
  header,
  language = 'JSON',
  maxRows,
  minRows = 14,
  textareaClassName,
  value,
  ...props
}: CodeEditorProps) {
  const text = typeof value === 'string' ? value : ''
  const contentLineCount = Math.max(minRows, text.split('\n').length)
  const visibleLineCount =
    maxRows === undefined ? contentLineCount : Math.min(contentLineCount, maxRows)
  const lineNumbers = Array.from({ length: visibleLineCount }, (_, index) => index + 1)

  return (
    <div
      className={cn(
        'overflow-hidden rounded-[6px] border border-border bg-code shadow-[0_1px_0_rgba(255,255,255,0.025)_inset]',
        className,
      )}
    >
      <div className="flex h-10 items-center justify-between border-border border-b bg-surface/85 px-3">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-[0.08em]">
          {language}
        </span>
        {header ? <div className="flex items-center gap-2">{header}</div> : null}
      </div>
      <div className="grid grid-cols-[3.25rem_1fr]">
        <div
          aria-hidden="true"
          className="select-none border-border border-r bg-code-gutter px-3 py-4 text-right text-dim-foreground text-xs leading-6"
        >
          {lineNumbers.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
        <textarea
          className={cn(
            'min-h-full resize-none overflow-auto border-0 bg-code px-4 py-4 font-mono text-xs leading-6 text-foreground outline-none placeholder:text-dim-foreground focus:shadow-none',
            textareaClassName,
          )}
          data-code="true"
          rows={visibleLineCount}
          spellCheck={false}
          value={value}
          wrap="off"
          {...props}
        />
      </div>
    </div>
  )
}
