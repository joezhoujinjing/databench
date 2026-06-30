import { useTranslation } from 'react-i18next'

export function NotFoundPage() {
  const { t } = useTranslation()

  return (
    <section className="rounded-md border border-border p-4">
      <h1 className="font-semibold text-xl">{t('notFound')}</h1>
    </section>
  )
}
