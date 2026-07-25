import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useBackend } from '@/api/backend.js'
import { Spinner } from '@/components/common/State.js'
import { useV2Dataset, useV2DatasetResolution, useV2DeleteRef } from '../api/hooks.js'
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
  const navigate = useNavigate()
  const resolution = useV2DatasetResolution(requestedRef)
  const deleteRef = useV2DeleteRef()
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
      canDelete={resolution.data?.ref_name === requestedRef}
      deleteError={deleteRef.error}
      isDeleting={deleteRef.isPending}
      latestVersion={resolution.data?.dataset_version ?? null}
      onAdoptLatest={() => {
        if (resolution.data !== undefined) setPinnedVersion(resolution.data.dataset_version)
      }}
      pinnedVersion={pinnedVersion}
      onDelete={() => {
        deleteRef.mutate(
          {
            name: requestedRef,
            request: { expected_version: pinnedVersion },
          },
          { onSuccess: () => void navigate({ to: '/datasets' }) },
        )
      }}
      requestedRef={requestedRef}
      view={exact.data}
    />
  )
}

export function keepPinnedVersion(current: string | null, resolved: string): string {
  return current ?? resolved
}
