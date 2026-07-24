import { useBackend } from '@/api/backend.js'
import { V2IngestPageView } from '../features/ingest/IngestPageView.js'

export function V2IngestPage() {
  const { connectionScope } = useBackend()
  return <V2IngestPageView key={connectionScope} />
}
