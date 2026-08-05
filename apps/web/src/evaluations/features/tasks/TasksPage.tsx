import { getRouteApi } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PageHeader,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { Tabs } from '@/components/ui/tabs.js'
import { useV2EvaluationRunByTask } from '@/v2/api/hooks.js'
import {
  buildEvaluationPayload,
  type DatabenchEvaluationBinding,
  type EvaluationFormValues,
  type EvaluationModelSourceKind,
  type EvaluationSourceKind,
} from '../../domain/form/evaluation.js'
import { useTaskRunner } from '../../hooks/use-task-runner.js'
import { DatabenchDatasetSource } from './DatabenchDatasetSource.js'
import { DatabenchDeploymentSource } from './DatabenchDeploymentSource.js'
import { EvaluationForm } from './EvaluationForm.js'
import { PerformanceForm } from './PerformanceForm.js'
import { TaskMonitor } from './TaskMonitor.js'

const routeApi = getRouteApi('/evaluations/tasks')

export function EvaluationTasksPage() {
  const { t } = useTranslation()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()

  const setTab = (tab: 'eval' | 'perf') => {
    void navigate({
      replace: true,
      search: (current) => ({ ...current, tab, taskId: undefined }),
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        description={t('evaluations.tasks.description')}
        title={t('evaluations.nav.tasks')}
      />
      <Tabs
        ariaLabel={t('evaluations.nav.tasks')}
        items={[
          {
            label: t('evaluations.tasks.evalTab'),
            panel: search.tab === 'eval' ? <EvaluationTaskPanel /> : null,
            value: 'eval',
          },
          {
            label: t('evaluations.tasks.perfTab'),
            panel: search.tab === 'perf' ? <PerformanceTaskPanel /> : null,
            value: 'perf',
          },
        ]}
        onChange={setTab}
        value={search.tab}
      />
    </div>
  )
}

function EvaluationTaskPanel() {
  const { t } = useTranslation()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const source: EvaluationSourceKind = search.source === 'databench' ? 'databench' : 'benchmark'
  const [binding, setBinding] = useState<DatabenchEvaluationBinding | null>(null)
  const [modelSource, setModelSource] = useState<EvaluationModelSourceKind>('manual')
  const [deploymentId, setDeploymentId] = useState<string | null>(null)
  const onBindingChange = useCallback(
    (nextBinding: DatabenchEvaluationBinding | null) => {
      setBinding(nextBinding)
      if (nextBinding !== null) {
        void navigate({
          replace: true,
          search: (current) => ({
            ...current,
            datasetVersion: nextBinding.datasetVersion,
          }),
        })
      }
    },
    [navigate],
  )
  const onTaskIdChange = useCallback(
    (taskId: string) => {
      void navigate({ replace: true, search: (current) => ({ ...current, taskId }) })
    },
    [navigate],
  )
  const runner = useTaskRunner({
    initialTaskId: search.taskId?.startsWith('eval_') ? search.taskId : undefined,
    kind: 'eval',
    onTaskIdChange,
  })
  const archiveRun = useV2EvaluationRunByTask(
    binding?.datasetVersion ?? search.datasetVersion ?? '',
    runner.state.taskId ?? '',
    source === 'databench' && runner.state.taskId !== null,
  )
  const disabled = runner.state.phase === 'running' || runner.state.phase === 'stopping'

  const onSourceChange = (nextSource: EvaluationSourceKind) => {
    setBinding(null)
    void navigate({
      replace: true,
      search: (current) => ({
        ...current,
        datasetVersion: nextSource === 'databench' ? current.datasetVersion : undefined,
        source: nextSource === 'databench' ? 'databench' : undefined,
      }),
    })
  }

  const onSubmit = (values: EvaluationFormValues) => {
    if (source === 'databench' && binding === null) return
    if (modelSource === 'databench-deployment' && deploymentId === null) return
    runner.start(
      buildEvaluationPayload(
        values,
        source,
        binding ?? undefined,
        modelSource === 'manual'
          ? { kind: 'manual' }
          : { deploymentId: deploymentId ?? '', kind: 'databench-deployment' },
      ),
    )
  }

  const onModelSourceChange = (nextSource: EvaluationModelSourceKind) => {
    setModelSource(nextSource)
    if (nextSource === 'manual') setDeploymentId(null)
  }

  return (
    <TaskWorkspace
      configTitle={t('evaluations.eval.config')}
      form={
        <EvaluationForm
          canSubmit={
            (source === 'benchmark' || binding !== null) &&
            (modelSource === 'manual' || deploymentId !== null)
          }
          databenchSource={(limit) => (
            <DatabenchDatasetSource
              disabled={disabled}
              initialDatasetVersion={search.datasetVersion}
              limit={limit}
              onBindingChange={onBindingChange}
            />
          )}
          deploymentSource={(maxOutputTokens) => (
            <DatabenchDeploymentSource
              deploymentId={deploymentId}
              disabled={disabled}
              {...(maxOutputTokens === undefined ? {} : { maxOutputTokens })}
              onChange={setDeploymentId}
            />
          )}
          disabled={disabled}
          initialBenchmark={search.benchmark}
          modelSource={modelSource}
          onModelSourceChange={onModelSourceChange}
          onSourceChange={onSourceChange}
          onSubmit={onSubmit}
          serverError={runner.state.error}
          source={source}
        />
      }
      monitor={
        <TaskMonitor
          archiveRun={archiveRun.data}
          onStop={runner.stop}
          showArchiveState={source === 'databench'}
          state={runner.state}
        />
      }
      statusTitle={t('evaluations.eval.status')}
    />
  )
}

function PerformanceTaskPanel() {
  const { t } = useTranslation()
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const onTaskIdChange = useCallback(
    (taskId: string) => {
      void navigate({ replace: true, search: (current) => ({ ...current, taskId }) })
    },
    [navigate],
  )
  const runner = useTaskRunner({
    initialTaskId: search.taskId?.startsWith('perf_') ? search.taskId : undefined,
    kind: 'perf',
    onTaskIdChange,
  })
  const disabled = runner.state.phase === 'running' || runner.state.phase === 'stopping'
  return (
    <TaskWorkspace
      configTitle={t('evaluations.perf.config')}
      form={<PerformanceForm disabled={disabled} onSubmit={runner.start} />}
      monitor={<TaskMonitor onStop={runner.stop} state={runner.state} />}
      statusTitle={t('evaluations.perf.status')}
    />
  )
}

function TaskWorkspace({
  configTitle,
  form,
  monitor,
  statusTitle,
}: {
  readonly configTitle: string
  readonly form: React.ReactNode
  readonly monitor: React.ReactNode
  readonly statusTitle: string
}) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{configTitle}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>{form}</SurfaceBody>
      </Surface>
      <Surface className="xl:sticky xl:top-5">
        <SurfaceHeader>
          <SurfaceTitle>{statusTitle}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>{monitor}</SurfaceBody>
      </Surface>
    </div>
  )
}
