import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'

export const INLINE_TEXT_MAX_CHARS = 32 * 1024
export const TEXT_PREVIEW_CHARS = 8 * 1024

export function SafeText({
  className,
  downloadName,
  text,
}: {
  className?: string
  downloadName: string
  text: string
}) {
  const { t } = useTranslation()
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  useEffect(
    () => () => {
      if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl)
    },
    [downloadUrl],
  )

  if (text.length <= INLINE_TEXT_MAX_CHARS) {
    return <span className={className}>{text}</span>
  }

  return (
    <span className={className}>
      <span>{safeTextPreview(text)}</span>
      <span aria-hidden="true">…</span>
      <span className="mt-3 block text-muted-foreground text-xs">
        {t('v2.record.textTruncated', { count: text.length })}
      </span>
      <span className="mt-2 flex flex-wrap gap-2">
        {downloadUrl === null ? (
          <Button
            onClick={() => {
              const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
              setDownloadUrl(URL.createObjectURL(blob))
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {t('v2.record.prepareTextDownload')}
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline">
            <a download={sanitizeTextDownloadName(downloadName)} href={downloadUrl}>
              <Download aria-hidden="true" size={15} />
              {t('v2.record.downloadText')}
            </a>
          </Button>
        )}
      </span>
    </span>
  )
}

export function safeTextPreview(text: string, limit = TEXT_PREVIEW_CHARS): string {
  let end = Math.min(text.length, limit)
  const lastCodeUnit = text.charCodeAt(end - 1)
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1
  return text.slice(0, end)
}

function sanitizeTextDownloadName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return sanitized === '' ? 'record-text.txt' : sanitized.slice(0, 120)
}
