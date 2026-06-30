import { Check, Copy } from 'lucide-react'
import { type MouseEvent, type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils.js'

export function CopyTextButton({
  children,
  className,
  label = 'Copy',
  onClick,
  text,
}: {
  children?: ReactNode
  className?: string
  label?: string
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  text: string
}) {
  const [copied, setCopied] = useState(false)

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    void copyText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => setCopied(false))
  }

  return (
    <button
      aria-label={copied ? `${label} copied` : label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[4px] text-dim-foreground transition hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        children ? 'h-10 gap-2 px-3 text-sm' : 'size-7',
        className,
      )}
      onClick={handleClick}
      title={copied ? `${label} copied` : label}
      type="button"
    >
      {copied ? (
        <Check aria-hidden="true" className="text-success" size={15} />
      ) : (
        <Copy aria-hidden="true" size={15} />
      )}
      {children ? <span>{children}</span> : null}
    </button>
  )
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Fall back for browser contexts where the async clipboard API exists
      // but is denied by permissions.
    }
  }

  fallbackCopyText(value)
}

function fallbackCopyText(value: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  document.body.append(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}
