import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'

export function AlignedSampleNavigator({
  index,
  onChange,
  sampleIndex,
  total,
}: {
  readonly index: string | undefined
  readonly onChange: (next: number) => void
  readonly sampleIndex: number
  readonly total: number
}) {
  const { t } = useTranslation()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (
        (event.target as HTMLElement | null)?.matches(
          'input, textarea, select, [contenteditable="true"]',
        )
      )
        return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onChange(Math.max(1, sampleIndex - 1))
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        onChange(Math.min(total, sampleIndex + 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onChange, sampleIndex, total])
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-border bg-surface/72 px-4 py-3">
      <span className="text-muted-foreground text-sm">
        {t('evaluations.compare.showing')}{' '}
        <strong className="text-foreground">{sampleIndex}</strong> {t('evaluations.compare.of')}{' '}
        <strong className="text-foreground">{total}</strong>
        {index ? <span className="ml-2 font-mono text-xs">Index {index}</span> : null}
      </span>
      <div className="flex gap-2">
        <Button
          aria-label={t('evaluations.prediction.previousSample')}
          disabled={sampleIndex <= 1}
          onClick={() => onChange(Math.max(1, sampleIndex - 1))}
          size="sm"
          variant="outline"
        >
          <ChevronLeft aria-hidden="true" size={14} />
        </Button>
        <Button
          aria-label={t('evaluations.prediction.nextSample')}
          disabled={sampleIndex >= total}
          onClick={() => onChange(Math.min(total, sampleIndex + 1))}
          size="sm"
          variant="outline"
        >
          <ChevronRight aria-hidden="true" size={14} />
        </Button>
      </div>
    </div>
  )
}
