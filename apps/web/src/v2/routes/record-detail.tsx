import { useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useBackend } from '@/api/backend.js'
import { Spinner } from '@/components/common/State.js'
import { useV2DatasetResolution, useV2Record } from '../api/hooks.js'
import { V2ReadErrorState } from '../components/V2ReadErrorState.js'
import { V2RecordDetailView } from '../features/datasets/RecordDetailView.js'

export function V2RecordDetailPage() {
  const params = useParams({ strict: false })
  const requestedRef = typeof params.ref === 'string' ? params.ref : ''
  const recordId = typeof params.recordId === 'string' ? params.recordId : ''
  const { connectionScope } = useBackend()

  return (
    <PinnedV2RecordDetailPage
      key={`${connectionScope}:${requestedRef}:${recordId}`}
      recordId={recordId}
      requestedRef={requestedRef}
    />
  )
}

function PinnedV2RecordDetailPage({
  recordId,
  requestedRef,
}: {
  recordId: string
  requestedRef: string
}) {
  const resolution = useV2DatasetResolution(requestedRef)
  const [pinnedVersion, setPinnedVersion] = useState<string | null>(null)
  const record = useV2Record(pinnedVersion ?? '', recordId)

  useEffect(() => {
    if (resolution.data !== undefined) {
      setPinnedVersion((current) => current ?? resolution.data.dataset_version)
    }
  }, [resolution.data])

  if (resolution.isLoading || (pinnedVersion !== null && record.isLoading)) return <Spinner />
  if (resolution.isError && pinnedVersion === null) {
    return (
      <V2ReadErrorState
        error={resolution.error}
        identifier={requestedRef}
        onRetry={() => void resolution.refetch()}
      />
    )
  }
  if (record.isError) {
    return (
      <V2ReadErrorState
        error={record.error}
        identifier={pinnedVersion ?? requestedRef}
        onRetry={() => void record.refetch()}
      />
    )
  }
  if (record.data === undefined) return <Spinner />

  return <V2RecordDetailView view={record.data} />
}
