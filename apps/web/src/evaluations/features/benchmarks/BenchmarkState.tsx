import { SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Surface } from '@/components/ui/surface.js'

export function BenchmarkState({ onClear }: { readonly onClear: () => void }) {
  const { t } = useTranslation()
  return (
    <Surface
      className="flex min-h-64 flex-col items-center justify-center p-8 text-center"
      role="status"
    >
      <SearchX aria-hidden="true" className="text-muted-foreground" size={27} />
      <h2 className="mt-4 font-semibold text-lg">{t('evaluations.benchmarks.noResults')}</h2>
      <Button className="mt-4" onClick={onClear} size="sm" variant="outline">
        {t('evaluations.benchmarks.clearFilters')}
      </Button>
    </Surface>
  )
}
