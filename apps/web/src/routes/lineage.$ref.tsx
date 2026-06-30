import { useParams } from '@tanstack/react-router'
import { LineagePageView } from '@/features/lineage/LineagePageView.js'

export function LineagePage() {
  const { ref } = useParams({ strict: false })
  return <LineagePageView initialRef={typeof ref === 'string' ? ref : ''} />
}

export { LineagePageView as LineageExplorer } from '@/features/lineage/LineagePageView.js'
