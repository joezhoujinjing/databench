import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { evalScopeClient } from '../../api/client.js'
import { type PredictionMode, subsetRows } from '../../domain/reports.js'
import { ChatView } from '../sample/ChatView.js'
import { MessageIdSearch } from './MessageIdSearch.js'
import { PredictionFilters } from './PredictionFilters.js'
import { PredictionNavigator } from './PredictionNavigator.js'

const PREDICTION_PAGE_SIZE = 50

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
  const [page, setPage] = useState(1)
  const [position, setPosition] = useState(0)
  const [highlightMessageId, setHighlightMessageId] = useState<string | undefined>()
  const pendingPosition = useRef<number | 'last' | null>(null)
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
    setPage(1)
    setPosition(0)
    setHighlightMessageId(undefined)
  }, [initialSubset, subsets])
  const predictionsQuery = useQuery({
    enabled: subset !== '',
    queryFn: ({ signal }) =>
      evalScopeClient.request('reportsPredictions', {
        query: {
          dataset_name: datasetName,
          mode,
          page,
          page_size: PREDICTION_PAGE_SIZE,
          report_name: reportName,
          subset_name: subset,
          threshold,
        },
        signal,
      }),
    queryKey: ['evalscope', 'predictions', reportName, datasetName, subset, mode, threshold, page],
    retry: false,
  })
  const predictions = predictionsQuery.data?.predictions ?? []
  const total = predictionsQuery.data?.total ?? 0
  const counts = predictionsQuery.data?.counts ?? { above: 0, all: 0, below: 0 }
  useEffect(() => {
    if (!predictionsQuery.data) return
    const requested = pendingPosition.current
    pendingPosition.current = null
    setPosition(
      requested === 'last'
        ? Math.max(0, predictionsQuery.data.predictions.length - 1)
        : Math.min(requested ?? 0, Math.max(0, predictionsQuery.data.predictions.length - 1)),
    )
  }, [predictionsQuery.data])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return
      if (event.key === 'ArrowLeft') {
        if (position > 0) setPosition((value) => value - 1)
        else if (page > 1) {
          pendingPosition.current = 'last'
          setPage((value) => value - 1)
        }
      }
      if (event.key === 'ArrowRight') {
        if (position < predictions.length - 1) setPosition((value) => value + 1)
        else if (page * PREDICTION_PAGE_SIZE < total) {
          pendingPosition.current = 0
          setPage((value) => value + 1)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [page, position, predictions.length, total])
  const row = predictions[position]
  const locate = async (locator: { index: string } | { message_id_prefix: string }) => {
    const response = await evalScopeClient.request('reportsPredictions', {
      query: {
        dataset_name: datasetName,
        mode,
        page,
        page_size: PREDICTION_PAGE_SIZE,
        report_name: reportName,
        subset_name: subset,
        threshold,
        ...locator,
      },
    })
    const match = response.match
    if (match?.status !== 'found') return match?.status ?? 'not-found'
    const nextPosition = (match.position - 1) % response.page_size
    if (response.page === page) setPosition(nextPosition)
    else {
      pendingPosition.current = nextPosition
      setPage(response.page)
    }
    return match
  }
  const searchIndex = async (query: string) => {
    const match = await locate({ index: query.trim() })
    if (match === 'not-found') return t('evaluations.prediction.indexNotFound')
    if (match === 'ambiguous') return t('evaluations.prediction.indexAmbiguous')
    setHighlightMessageId(undefined)
    return null
  }
  const searchMessage = async (query: string) => {
    const match = await locate({ message_id_prefix: query.trim() })
    if (match === 'not-found') return t('evaluations.prediction.messageNotFound')
    if (match === 'ambiguous') return t('evaluations.prediction.messageAmbiguous')
    setHighlightMessageId(match.message_id)
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
          setPage(1)
          setPosition(0)
          setHighlightMessageId(undefined)
        }}
        onSubsetChange={(value) => {
          setSubset(value)
          setPage(1)
          setPosition(0)
          setHighlightMessageId(undefined)
        }}
        onThresholdChange={(value) => {
          setThreshold(value)
          setPage(1)
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
      ) : predictions.length === 0 ? (
        <Alert>
          {counts.all === 0
            ? t('evaluations.common.noData')
            : t('evaluations.prediction.noFilteredSamples')}
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <PredictionNavigator
              current={(page - 1) * PREDICTION_PAGE_SIZE + position + 1}
              indexValue={row?.Index}
              onIndexSearch={searchIndex}
              onNext={() => {
                if (position < predictions.length - 1) setPosition((value) => value + 1)
                else if (page * PREDICTION_PAGE_SIZE < total) {
                  pendingPosition.current = 0
                  setPage((value) => value + 1)
                }
                setHighlightMessageId(undefined)
              }}
              onPrevious={() => {
                if (position > 0) setPosition((value) => value - 1)
                else if (page > 1) {
                  pendingPosition.current = 'last'
                  setPage((value) => value - 1)
                }
                setHighlightMessageId(undefined)
              }}
              total={total}
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
