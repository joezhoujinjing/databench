import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { Tabs } from '@/components/ui/tabs.js'
import { evalScopeClient } from '../api/client.js'
import { EvaluationBreadcrumb } from '../components/common/EvaluationBreadcrumb.js'
import { PredictionsTab } from '../features/predictions/PredictionsTab.js'
import { DetailsTab } from '../features/reports/DetailsTab.js'
import { OverviewTab } from '../features/reports/OverviewTab.js'
import { ReportHeader } from '../features/reports/ReportHeader.js'

const routeApi = getRouteApi('/evaluations/reports/$reportKey')
type DetailTab = 'details' | 'overview' | 'predictions'

export function EvaluationReportDetailRoute() {
  const { t } = useTranslation()
  const { reportKey: reportName } = routeApi.useParams()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const query = useQuery({
    queryFn: ({ signal }) =>
      evalScopeClient.request('reportsLoad', { query: { report_name: reportName }, signal }),
    queryKey: ['evalscope', 'report', reportName],
    retry: false,
  })
  const availableDatasets = query.data?.datasets ?? []
  const dataset =
    search.dataset !== undefined && availableDatasets.includes(search.dataset)
      ? search.dataset
      : (availableDatasets[0] ?? '')
  useEffect(() => {
    if (dataset !== '' && dataset !== search.dataset) {
      void navigate({
        replace: true,
        search: (current) => ({ ...current, dataset, subset: undefined }),
      })
    }
  }, [dataset, navigate, search.dataset])
  const report = useMemo(
    () => query.data?.report_list.find((item) => item.dataset_name === dataset),
    [dataset, query.data?.report_list],
  )
  const modelLabel = query.data?.report_list[0]?.model_name ?? reportName
  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-36" />
        <Skeleton className="h-80" />
      </div>
    )
  }
  if (query.error || query.data === undefined) {
    return (
      <div className="space-y-5">
        <EvaluationBreadcrumb
          items={[
            { label: t('evaluations.reports.title'), to: '/evaluations/reports' },
            { label: modelLabel },
          ]}
          label={t('evaluations.foundation.navigation')}
        />
        <Alert className="border-danger/30" role="alert">
          <p>
            {query.error instanceof Error ? query.error.message : t('evaluations.common.loadError')}
          </p>
          <Button className="mt-3" onClick={() => void query.refetch()} size="sm" variant="outline">
            {t('evaluations.common.retry')}
          </Button>
        </Alert>
      </div>
    )
  }
  const changeDataset = (nextDataset: string) => {
    void navigate({
      search: (current) => ({
        ...current,
        dataset: nextDataset,
        subset: undefined,
        tab: current.tab === 'overview' ? 'details' : current.tab,
      }),
    })
  }
  const openPredictions = (subset: string) => {
    void navigate({
      search: (current) => ({ ...current, dataset, subset, tab: 'predictions' }),
    })
  }
  return (
    <div className="space-y-5">
      <EvaluationBreadcrumb
        items={[
          { label: t('evaluations.reports.title'), to: '/evaluations/reports' },
          { label: modelLabel },
        ]}
        label={t('evaluations.foundation.navigation')}
      />
      <ReportHeader
        activeDataset={dataset}
        datasets={query.data.datasets}
        onDatasetChange={changeDataset}
        reportName={reportName}
        reports={query.data.report_list}
      />
      <Tabs
        ariaLabel={t('evaluations.reportDetail.tabsLabel')}
        items={[
          {
            label: t('evaluations.reportDetail.overview'),
            panel: (
              <OverviewTab
                onDatasetClick={changeDataset}
                reportName={reportName}
                reports={query.data.report_list}
                taskConfig={query.data.task_config}
              />
            ),
            value: 'overview',
          },
          {
            label: t('evaluations.reportDetail.details'),
            panel: (
              <DetailsTab
                datasetName={dataset}
                onSubsetClick={openPredictions}
                report={report}
                reportName={reportName}
              />
            ),
            value: 'details',
          },
          {
            label: t('evaluations.reportDetail.predictions'),
            panel: (
              <PredictionsTab
                datasetName={dataset}
                initialSubset={search.subset}
                reportName={reportName}
              />
            ),
            value: 'predictions',
          },
        ]}
        onChange={(tab: DetailTab) => void navigate({ search: (current) => ({ ...current, tab }) })}
        value={search.tab}
      />
    </div>
  )
}
