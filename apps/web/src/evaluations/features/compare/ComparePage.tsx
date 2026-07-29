import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { PageHeader } from '@/components/ui/surface.js'
import { Tabs } from '@/components/ui/tabs.js'
import { evalScopeClient } from '../../api/client.js'
import type { PredictionRow } from '../../api/schemas.js'
import {
  aboveRates,
  alignPredictions,
  commonDatasets,
  commonSubsets,
  decodeCompareReports,
  encodeCompareReports,
  encodeModelFilters,
  filterAlignedPredictions,
  MAX_COMPARE_MODELS,
  parseModelFilters,
  type TaggedReportData,
} from '../../domain/compare.js'
import { AlignedSampleNavigator } from './AlignedSampleNavigator.js'
import { ParallelSamples } from './ParallelSamples.js'
import { ComparePredictionFilters } from './PredictionFilters.js'
import { ScoreComparison } from './ScoreComparison.js'

const routeApi = getRouteApi('/evaluations/compare')

export function ComparePage() {
  const { t } = useTranslation()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const reportNames = useMemo(() => decodeCompareReports(search.reports), [search.reports])
  const [adding, setAdding] = useState(false)
  const [reportInput, setReportInput] = useState('')
  const reportQuery = useQuery({
    enabled: reportNames.length >= 2,
    queryFn: async ({ signal }) => {
      const responses = await Promise.all(
        reportNames.map((name) =>
          evalScopeClient.request('reportsLoad', { query: { report_name: name }, signal }),
        ),
      )
      return responses.flatMap((response, index) =>
        response.report_list.map(
          (row): TaggedReportData => ({ ...row, reportName: reportNames[index] ?? '' }),
        ),
      )
    },
    queryKey: ['evalscope', 'compare', 'reports', reportNames.join(';')],
    retry: false,
  })
  const rows = reportQuery.data ?? []
  const datasets = useMemo(() => commonDatasets(rows, reportNames), [reportNames, rows])
  const selectedDataset =
    search.dataset && datasets.includes(search.dataset) ? search.dataset : (datasets[0] ?? '')
  const subsets = useMemo(
    () => commonSubsets(rows, reportNames, selectedDataset),
    [reportNames, rows, selectedDataset],
  )
  const selectedSubset =
    search.subset && subsets.includes(search.subset) ? search.subset : (subsets[0] ?? '')
  const labels = useMemo(
    () =>
      Object.fromEntries(
        reportNames.map((name) => [
          name,
          rows.find((row) => row.reportName === name)?.model_name ?? name,
        ]),
      ),
    [reportNames, rows],
  )
  useEffect(() => {
    if (!reportQuery.data) return
    if (selectedDataset !== (search.dataset ?? '') || selectedSubset !== (search.subset ?? '')) {
      void navigate({
        replace: true,
        search: (current) => ({
          ...current,
          dataset: selectedDataset || undefined,
          sample: 1,
          subset: selectedSubset || undefined,
        }),
      })
    }
  }, [navigate, reportQuery.data, search.dataset, search.subset, selectedDataset, selectedSubset])
  const predictions = useQuery({
    enabled:
      search.tab === 'prediction' &&
      Boolean(selectedDataset && selectedSubset) &&
      reportNames.length >= 2,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled(
        reportNames.map((name) =>
          evalScopeClient.request('reportsPredictions', {
            query: {
              dataset_name: selectedDataset,
              report_name: name,
              subset_name: selectedSubset,
            },
            signal,
          }),
        ),
      )
      const byModel: Record<string, readonly PredictionRow[]> = {}
      const errors: Record<string, string> = {}
      results.forEach((result, index) => {
        const name = reportNames[index]
        if (!name) return
        if (result.status === 'fulfilled') byModel[name] = result.value.predictions
        else
          errors[name] =
            result.reason instanceof Error
              ? result.reason.message
              : t('evaluations.common.loadError')
      })
      return { byModel, errors }
    },
    queryKey: [
      'evalscope',
      'compare',
      'predictions',
      reportNames.join(';'),
      selectedDataset,
      selectedSubset,
    ],
    retry: false,
  })
  const successfulNames = reportNames.filter(
    (name) => predictions.data?.byModel[name] !== undefined,
  )
  const aligned = alignPredictions(predictions.data?.byModel ?? {}, successfulNames)
  const filters = parseModelFilters(search.filters, reportNames)
  const filtered = filterAlignedPredictions(aligned, successfulNames, filters, search.threshold)
  const rates = aboveRates(aligned, successfulNames, search.threshold)
  const sampleIndex = Math.min(search.sample, Math.max(1, filtered.length))
  const current = filtered[sampleIndex - 1]
  const updateReports = (next: readonly string[]) =>
    void navigate({
      search: (currentSearch) => ({
        ...currentSearch,
        dataset: undefined,
        filters: undefined,
        reports: encodeCompareReports(next),
        sample: 1,
        subset: undefined,
      }),
    })
  const addReport = () => {
    const value = reportInput.trim()
    if (!value || reportNames.includes(value) || reportNames.length >= MAX_COMPARE_MODELS) return
    updateReports([...reportNames, value])
    setReportInput('')
    setAdding(false)
  }
  return (
    <div className="space-y-5">
      <PageHeader
        description={t('evaluations.compare.description')}
        title={t('evaluations.compare.title')}
      />
      <div className="flex flex-wrap items-center gap-2 border-border border-y py-3">
        <span className="mr-1 text-muted-foreground text-sm">
          {t('evaluations.compare.selectedModels')}
        </span>
        {reportNames.map((name) => (
          <Badge className="gap-1.5 py-1" key={name} tone="muted">
            <span className="max-w-56 truncate">{labels[name] ?? name}</span>
            <button
              aria-label={`${t('evaluations.common.remove')} ${labels[name] ?? name}`}
              disabled={reportNames.length <= 2}
              onClick={() => updateReports(reportNames.filter((item) => item !== name))}
              type="button"
            >
              <X aria-hidden="true" size={12} />
            </button>
          </Badge>
        ))}
        {adding ? (
          <form
            className="flex min-w-64 flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              addReport()
            }}
          >
            <TextInput
              aria-label={t('evaluations.compare.reportNamePlaceholder')}
              autoFocus
              onChange={(event) => setReportInput(event.target.value)}
              placeholder={t('evaluations.compare.reportNamePlaceholder')}
              value={reportInput}
            />
            <Button disabled={!reportInput.trim()} size="sm" type="submit">
              {t('evaluations.compare.addModel')}
            </Button>
            <Button
              aria-label={t('evaluations.compare.cancelAdd')}
              onClick={() => {
                setAdding(false)
                setReportInput('')
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={14} />
            </Button>
          </form>
        ) : reportNames.length < MAX_COMPARE_MODELS ? (
          <Button onClick={() => setAdding(true)} size="sm" variant="outline">
            <Plus aria-hidden="true" size={14} />
            {t('evaluations.compare.addModel')}
          </Button>
        ) : null}
      </div>
      {reportNames.length < 2 ? (
        <Alert role="status">
          {t('evaluations.compare.needTwo')}{' '}
          <Link className="font-medium text-primary hover:underline" to="/evaluations/reports">
            {t('evaluations.nav.reports')}
          </Link>
        </Alert>
      ) : reportQuery.isLoading ? (
        <p className="text-muted-foreground text-sm">{t('evaluations.common.loading')}</p>
      ) : reportQuery.error ? (
        <Alert role="alert">
          {reportQuery.error instanceof Error
            ? reportQuery.error.message
            : t('evaluations.common.loadError')}
        </Alert>
      ) : datasets.length === 0 ? (
        <Alert className="border-warning/35" role="status">
          <strong>{t('evaluations.compare.incompatible')}</strong>
          <span className="ml-2 text-muted-foreground">
            {t('evaluations.compare.incompatibleHint')}
          </span>
        </Alert>
      ) : (
        <Tabs
          ariaLabel={t('evaluations.compare.title')}
          items={[
            {
              label: t('evaluations.compare.scoreComparison'),
              panel: (
                <ScoreComparison commonDatasets={datasets} reportNames={reportNames} rows={rows} />
              ),
              value: 'score' as const,
            },
            {
              label: t('evaluations.compare.predictionComparison'),
              panel: (
                <div className="space-y-4">
                  <ComparePredictionFilters
                    aboveRates={rates}
                    datasets={datasets}
                    filters={filters}
                    onDatasetChange={(dataset) =>
                      void navigate({
                        search: (currentSearch) => ({
                          ...currentSearch,
                          dataset,
                          sample: 1,
                          subset: undefined,
                        }),
                      })
                    }
                    onFiltersChange={(next) =>
                      void navigate({
                        replace: true,
                        search: (currentSearch) => ({
                          ...currentSearch,
                          filters: encodeModelFilters(next, reportNames),
                          sample: 1,
                        }),
                      })
                    }
                    onSubsetChange={(subset) =>
                      void navigate({
                        search: (currentSearch) => ({ ...currentSearch, sample: 1, subset }),
                      })
                    }
                    onThresholdChange={(threshold) =>
                      void navigate({
                        replace: true,
                        search: (currentSearch) => ({ ...currentSearch, sample: 1, threshold }),
                      })
                    }
                    reportLabels={labels}
                    reportNames={reportNames}
                    selectedDataset={selectedDataset}
                    selectedSubset={selectedSubset}
                    subsets={subsets}
                    threshold={search.threshold}
                  />
                  {predictions.isLoading ? (
                    <p className="text-muted-foreground text-sm">
                      {t('evaluations.common.loading')}
                    </p>
                  ) : predictions.error ? (
                    <Alert role="alert">
                      {predictions.error instanceof Error
                        ? predictions.error.message
                        : t('evaluations.common.loadError')}
                    </Alert>
                  ) : filtered.length ? (
                    <>
                      <AlignedSampleNavigator
                        index={current?.index}
                        onChange={(sample) =>
                          void navigate({
                            search: (currentSearch) => ({ ...currentSearch, sample }),
                          })
                        }
                        sampleIndex={sampleIndex}
                        total={filtered.length}
                      />
                      <div className="overflow-x-auto">
                        <ParallelSamples
                          errors={predictions.data?.errors ?? {}}
                          labels={labels}
                          reportNames={reportNames}
                          row={current}
                          threshold={search.threshold}
                        />
                      </div>
                    </>
                  ) : predictions.data && Object.keys(predictions.data.errors).length > 0 ? (
                    <div className="overflow-x-auto">
                      <ParallelSamples
                        errors={predictions.data.errors}
                        labels={labels}
                        reportNames={reportNames}
                        row={undefined}
                        threshold={search.threshold}
                      />
                    </div>
                  ) : (
                    <Alert role="status">
                      {aligned.length
                        ? t('evaluations.compare.noFilteredPredictions')
                        : t('evaluations.common.noData')}
                    </Alert>
                  )}
                </div>
              ),
              value: 'prediction' as const,
            },
          ]}
          onChange={(tab) =>
            void navigate({ search: (current) => ({ ...current, sample: 1, tab }) })
          }
          value={search.tab}
        />
      )}
    </div>
  )
}
