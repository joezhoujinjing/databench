import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { evalScopeClient } from '../../api/client.js'
import {
  filterPredictions,
  findPredictionByIndex,
  findPredictionByMessagePrefix,
  type PredictionMode,
  predictionCounts,
  subsetRows,
} from '../../domain/reports.js'
import { ChatView } from '../sample/ChatView.js'
import { MessageIdSearch } from './MessageIdSearch.js'
import { PredictionFilters } from './PredictionFilters.js'
import { PredictionNavigator } from './PredictionNavigator.js'

export function PredictionsTab({
  datasetName,
  initialSubset,
  reportName,
}: {
  readonly datasetName: string
  readonly initialSubset?: string | undefined
  readonly reportName: string
}) {
  const { t } = useTranslation()
  const [subset, setSubset] = useState('')
  const [mode, setMode] = useState<PredictionMode>('all')
  const [threshold, setThreshold] = useState(0.99)
  const [position, setPosition] = useState(0)
  const [highlightMessageId, setHighlightMessageId] = useState<string | undefined>()
  const subsetsQuery = useQuery({
    enabled: datasetName !== '',
    queryFn: ({ signal }) =>
      evalScopeClient.request('reportsDataFrame', {
        query: { dataset_name: datasetName, report_name: reportName, type: 'dataset' },
        signal,
      }),
    queryKey: ['evalscope', 'prediction-subsets', reportName, datasetName],
    retry: false,
  })
  const subsets = useMemo(
    () => subsetRows(subsetsQuery.data ?? { columns: [], data: [] }).map((row) => row.subset),
    [subsetsQuery.data],
  )
  useEffect(() => {
    const selected =
      initialSubset && subsets.includes(initialSubset) ? initialSubset : (subsets[0] ?? '')
    setSubset(selected)
    setPosition(0)
    setHighlightMessageId(undefined)
  }, [initialSubset, subsets])
  const predictionsQuery = useQuery({
    enabled: subset !== '',
    queryFn: ({ signal }) =>
      evalScopeClient.request('reportsPredictions', {
        query: { dataset_name: datasetName, report_name: reportName, subset_name: subset },
        signal,
      }),
    queryKey: ['evalscope', 'predictions', reportName, datasetName, subset],
    retry: false,
  })
  const predictions = predictionsQuery.data?.predictions ?? []
  const filtered = useMemo(
    () => filterPredictions(predictions, mode, threshold),
    [mode, predictions, threshold],
  )
  const counts = useMemo(() => predictionCounts(predictions, threshold), [predictions, threshold])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return
      if (event.key === 'ArrowLeft') setPosition((value) => Math.max(0, value - 1))
      if (event.key === 'ArrowRight')
        setPosition((value) => Math.min(Math.max(0, filtered.length - 1), value + 1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [filtered.length])
  const row = filtered[position]
  const searchIndex = (query: string) => {
    const index = findPredictionByIndex(filtered, query)
    if (index === null) return t('evaluations.prediction.indexNotFound')
    setPosition(index)
    setHighlightMessageId(undefined)
    return null
  }
  const searchMessage = (query: string) => {
    const result = findPredictionByMessagePrefix(filtered, query)
    if (result.kind === 'not-found') return t('evaluations.prediction.messageNotFound')
    if (result.kind === 'ambiguous') return t('evaluations.prediction.messageAmbiguous')
    setPosition(result.predictionIndex)
    setHighlightMessageId(result.messageId)
    return null
  }
  if (subsetsQuery.isLoading) return <Skeleton className="h-60" />
  if (subsetsQuery.error)
    return (
      <Alert className="border-danger/30" role="alert">
        {subsetsQuery.error instanceof Error
          ? subsetsQuery.error.message
          : t('evaluations.common.loadError')}
      </Alert>
    )
  return (
    <div className="space-y-4">
      <PredictionFilters
        counts={counts}
        mode={mode}
        onModeChange={(value) => {
          setMode(value)
          setPosition(0)
          setHighlightMessageId(undefined)
        }}
        onSubsetChange={(value) => {
          setSubset(value)
          setPosition(0)
          setHighlightMessageId(undefined)
        }}
        onThresholdChange={(value) => {
          setThreshold(value)
          setPosition(0)
          setHighlightMessageId(undefined)
        }}
        subset={subset}
        subsets={subsets}
        threshold={threshold}
      />
      {predictionsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-80" />
        </div>
      ) : predictionsQuery.error ? (
        <Alert className="border-danger/30" role="alert">
          <p>
            {predictionsQuery.error instanceof Error
              ? predictionsQuery.error.message
              : t('evaluations.common.loadError')}
          </p>
          <Button
            className="mt-3"
            onClick={() => void predictionsQuery.refetch()}
            size="sm"
            variant="outline"
          >
            {t('evaluations.common.retry')}
          </Button>
        </Alert>
      ) : filtered.length === 0 ? (
        <Alert>
          {predictions.length === 0
            ? t('evaluations.common.noData')
            : t('evaluations.prediction.noFilteredSamples')}
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <PredictionNavigator
              current={position + 1}
              indexValue={row?.Index}
              onIndexSearch={searchIndex}
              onNext={() => {
                setPosition((value) => Math.min(filtered.length - 1, value + 1))
                setHighlightMessageId(undefined)
              }}
              onPrevious={() => {
                setPosition((value) => Math.max(0, value - 1))
                setHighlightMessageId(undefined)
              }}
              total={filtered.length}
            />
            <MessageIdSearch onSearch={searchMessage} />
          </div>
          {highlightMessageId ? (
            <p className="text-muted-foreground text-xs" role="status">
              {t('evaluations.prediction.messageLocated', { id: highlightMessageId })}
            </p>
          ) : null}
          {row ? (
            <ChatView
              highlightMessageId={highlightMessageId}
              prediction={row}
              threshold={threshold}
            />
          ) : null}
        </>
      )}
    </div>
  )
}
