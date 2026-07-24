import { useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useBackend } from '@/api/backend.js'
import { Spinner } from '@/components/common/State.js'
import { useV2Dataset, useV2DatasetResolution } from '../api/hooks.js'
import { V2ReadErrorState } from '../components/V2ReadErrorState.js'
import { V2DatasetDetailView } from '../features/datasets/DatasetDetailView.js'

export function V2DatasetDetailPage() {
  const { ref } = useParams({ strict: false })
  const requestedRef = typeof ref === 'string' ? ref : ''
  const { connectionScope } = useBackend()
  return (
    <PinnedV2DatasetDetailPage
      key={`${connectionScope}:${requestedRef}`}
      requestedRef={requestedRef}
    />
  )
}

function PinnedV2DatasetDetailPage({ requestedRef }: { requestedRef: string }) {
  const resolution = useV2DatasetResolution(requestedRef)
  const [pinnedVersion, setPinnedVersion] = useState<string | null>(null)
  const exact = useV2Dataset(pinnedVersion ?? '')

  useEffect(() => {
    if (resolution.data !== undefined) {
      setPinnedVersion((current) => keepPinnedVersion(current, resolution.data.dataset_version))
    }
  }, [resolution.data])

  if (resolution.isLoading && pinnedVersion === null) return <Spinner />
  if (resolution.isError && pinnedVersion === null) {
    return (
      <V2ReadErrorState
        error={resolution.error}
        identifier={requestedRef}
        onRetry={() => void resolution.refetch()}
      />
    )
  }
  if (pinnedVersion === null || exact.isLoading) return <Spinner />
  if (exact.isError) {
    return (
      <V2ReadErrorState
        error={exact.error}
        identifier={pinnedVersion}
        onRetry={() => void exact.refetch()}
      />
    )
  }
  if (exact.data === undefined) return <Spinner />

  return (
    <V2DatasetDetailView
      latestVersion={resolution.data?.dataset_version ?? null}
      onAdoptLatest={() => {
        if (resolution.data !== undefined) setPinnedVersion(resolution.data.dataset_version)
      }}
      pinnedVersion={pinnedVersion}
      requestedRef={requestedRef}
      view={exact.data}
    />
  )
}

export function keepPinnedVersion(current: string | null, resolved: string): string {
  return current ?? resolved
}
