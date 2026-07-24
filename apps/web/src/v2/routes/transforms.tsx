import { useBackend } from '@/api/backend.js'
import { V2TransformsPageView } from '../features/transforms/TransformsPageView.js'

export function V2TransformsPage() {
  const { connectionScope } = useBackend()
  return <V2TransformsPageView key={connectionScope} />
}
