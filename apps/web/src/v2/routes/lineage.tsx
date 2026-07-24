import { useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useBackend } from '@/api/backend.js'
import { Spinner } from '@/components/common/State.js'
import { useV2DatasetResolution } from '../api/hooks.js'
import { V2ReadErrorState } from '../components/V2ReadErrorState.js'
import { V2LineagePageView } from '../features/lineage/LineagePageView.js'

export function V2LineagePage() {
  const { ref } = useParams({ strict: false })
  const requestedRef = typeof ref === 'string' ? ref : ''
  const { connectionScope } = useBackend()
  return <PinnedLineage key={`${connectionScope}:${requestedRef}`} requestedRef={requestedRef} />
}

function PinnedLineage({ requestedRef }: { requestedRef: string }) {
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
  return <V2LineagePageView exactVersion={exactVersion} requestedRef={requestedRef} />
}
