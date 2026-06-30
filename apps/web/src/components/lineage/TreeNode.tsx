import { useState } from 'react'

export function TreeNode({
  defaultOpen = false,
  label,
  value,
}: {
  defaultOpen?: boolean
  label: string
  value: unknown
}) {
  const [open, setOpen] = useState(defaultOpen)

  if (!isContainer(value)) {
    return (
      <div className="text-sm">
        <span className="font-medium text-muted-foreground">{label}:</span>{' '}
        <span>{primitiveText(value)}</span>
      </div>
    )
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value)

  return (
    <div className="space-y-1 text-sm">
      <button
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span aria-hidden="true" className="w-3 text-muted-foreground">
          {open ? '-' : '+'}
        </span>
        <span className="font-medium">{label}</span>
        {!open ? <span className="text-muted-foreground">{preview(value)}</span> : null}
      </button>
      {open ? (
        <div className="ml-4 space-y-1 border-border border-l pl-3">
          {entries.length === 0 ? (
            <div className="text-muted-foreground">{Array.isArray(value) ? '[]' : '{}'}</div>
          ) : (
            entries.map(([key, child]) => <TreeNode key={key} label={key} value={child} />)
          )}
        </div>
      ) : null}
    </div>
  )
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object'
}

function primitiveText(value: unknown): string {
  if (value === null) {
    return 'null'
  }

  if (typeof value === 'string') {
    return value
  }

  return String(value)
}

function preview(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) {
    return `[${value.length}]`
  }

  const keys = Object.keys(value)
  const head = keys.slice(0, 3).join(', ')
  return `{${head}${keys.length > 3 ? ', ...' : ''}}`
}
