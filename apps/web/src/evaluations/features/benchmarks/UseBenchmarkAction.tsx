import { Link } from '@tanstack/react-router'
import { Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'

export function UseBenchmarkAction({ benchmark }: { readonly benchmark: string }) {
  const { t } = useTranslation()
  return (
    <Button asChild>
      <Link search={{ benchmark, tab: 'eval' }} to="/evaluations/tasks">
        <Play aria-hidden="true" size={14} />
        {t('evaluations.benchmarks.useBenchmark')}
      </Link>
    </Button>
  )
}
