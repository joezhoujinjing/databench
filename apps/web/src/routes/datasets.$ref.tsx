import { useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { FEATURES, useFeature, useModuleEnabled } from '@/api/capabilities.js'
import { useDataset } from '@/api/hooks.js'
import { DatasetDetailView, type PAGE_SIZES } from '@/features/datasets/DatasetDetailView.js'

export function DatasetDetailPage() {
  const { ref } = useParams({ strict: false })
  const refName = typeof ref === 'string' ? ref : ''
  const dataset = useDataset(refName)
  const lineageEnabled = useModuleEnabled(FEATURES.lineage)
  const exportEnabled = useFeature(FEATURES.export)
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(20)

  return (
    <DatasetDetailView
      dataset={dataset.data}
      error={dataset.error}
      exportEnabled={exportEnabled}
      isError={dataset.isError}
      isLoading={dataset.isLoading}
      lineageEnabled={lineageEnabled}
      pageSize={pageSize}
      refName={refName}
      setPageSize={setPageSize}
    />
  )
}
