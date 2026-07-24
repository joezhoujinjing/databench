import { useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useBackend } from '@/api/backend.js'
import { Spinner } from '@/components/common/State.js'
import { useV2DatasetResolution } from '../api/hooks.js'
import { V2ReadErrorState } from '../components/V2ReadErrorState.js'
import { V2ExportPageView } from '../features/export/ExportPageView.js'

export function V2ExportPage() {
  const { ref } = useParams({ strict: false })
  const requestedRef = typeof ref === 'string' ? ref : ''
  const { connectionScope } = useBackend()
  return <PinnedExport key={`${connectionScope}:${requestedRef}`} requestedRef={requestedRef} />
}

function PinnedExport({ requestedRef }: { requestedRef: string }) {
  const resolution = useV2DatasetResolution(requestedRef)
  const [exactVersion, setExactVersion] = useState<string | null>(null)
  useEffect(() => {
    if (resolution.data) setExactVersion((current) => current ?? resolution.data.dataset_version)
  }, [resolution.data])

  if (resolution.isError && exactVersion === null) {
    return (
      <V2ReadErrorState
        error={resolution.error}
        identifier={requestedRef}
        onRetry={() => void resolution.refetch()}
      />
    )
  }
  if (exactVersion === null) return <Spinner />
  return <V2ExportPageView exactVersion={exactVersion} requestedRef={requestedRef} />
}
