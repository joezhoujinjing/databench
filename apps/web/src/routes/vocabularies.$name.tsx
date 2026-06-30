import { useParams } from '@tanstack/react-router'
import { VocabularyDetailPageView } from '@/features/vocabularies/VocabulariesPageView.js'

export function VocabularyDetailPage() {
  const { name } = useParams({ from: '/vocabularies/$name' })

  return <VocabularyDetailPageView name={name} />
}
