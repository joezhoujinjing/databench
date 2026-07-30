import { Check, Database, Search } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import { formatInteger } from '@/lib/format.js'
import { useV2Dataset, useV2InspectExport, useV2Refs } from '@/v2/api/hooks.js'
import type { ExportPlanV2, RefMetadataV2 } from '@/v2/api/types.js'
import { FidelityReview, hasSemanticChanges } from '@/v2/components/export/FidelityReview.js'
import { V2MutationError } from '@/v2/components/V2MutationError.js'
import type {
  DatabenchEvaluationBinding,
  DatabenchTargetSource,
} from '../../domain/form/evaluation.js'
import { TaskFormField } from './TaskFormField.js'

const EXACT_VERSION = /^[0-9a-f]{64}$/u

export function DatabenchDatasetSource({
  disabled,
  initialDatasetVersion,
  limit,
  onBindingChange,
}: {
  readonly disabled: boolean
  readonly initialDatasetVersion?: string | undefined
  readonly limit: string
  readonly onBindingChange: (binding: DatabenchEvaluationBinding | null) => void
}) {
  const { t } = useTranslation()
  const refsQuery = useV2Refs(100)
  const inspect = useV2InspectExport()
  const [refSearch, setRefSearch] = useState('')
  const [selectedRef, setSelectedRef] = useState<RefMetadataV2 | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(
    initialDatasetVersion !== undefined && EXACT_VERSION.test(initialDatasetVersion)
      ? initialDatasetVersion
      : '',
  )
  const [targetSource, setTargetSource] = useState<DatabenchTargetSource | ''>('')
  const [plan, setPlan] = useState<ExportPlanV2 | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeRefIndex, setActiveRefIndex] = useState(-1)
  const refListboxId = `${useId()}-refs`
  const inspectController = useRef<AbortController | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const dataset = useV2Dataset(datasetVersion)
  const refs = useMemo(
    () => refsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [refsQuery.data],
  )
  const visibleRefs = useMemo(() => {
    const search = refSearch.trim().toLocaleLowerCase()
    if (search === '') return refs.slice(0, 12)
    return refs.filter((ref) => ref.name.toLocaleLowerCase().includes(search)).slice(0, 12)
  }, [refSearch, refs])
  const parsedLimit = Number(limit)
  const evaluationSampleCount =
    plan === null || limit === '' || !Number.isSafeInteger(parsedLimit) || parsedLimit <= 0
      ? plan?.output_count
      : Math.min(plan.output_count, parsedLimit)

  useEffect(() => {
    if (selectedRef !== null || datasetVersion === '') return
    const matches = refs.filter((ref) => ref.version === datasetVersion)
    if (matches.length === 1 && matches[0] !== undefined) {
      setSelectedRef(matches[0])
      setRefSearch(matches[0].name)
    }
  }, [datasetVersion, refs, selectedRef])

  useEffect(() => {
    void datasetVersion
    void targetSource
    inspectController.current?.abort()
    inspectController.current = null
    setPlan(null)
    setConfirmed(false)
    onBindingChange(null)
  }, [datasetVersion, onBindingChange, targetSource])

  useEffect(() => {
    if (
      targetSource === '' ||
      plan === null ||
      plan.output_count <= 0 ||
      (hasSemanticChanges(plan) && !confirmed)
    ) {
      onBindingChange(null)
      return
    }
    onBindingChange({
      acceptedFidelityDigest: plan.fidelity_digest,
      datasetVersion: plan.dataset_version,
      sourceRef: selectedRef?.name ?? null,
      targetSource,
    })
  }, [confirmed, onBindingChange, plan, selectedRef, targetSource])

  useEffect(() => {
    if (!pickerOpen) return
    const close = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [pickerOpen])

  useEffect(
    () => () => {
      inspectController.current?.abort()
    },
    [],
  )

  const chooseRef = (ref: RefMetadataV2) => {
    setSelectedRef(ref)
    setRefSearch(ref.name)
    setDatasetVersion(ref.version)
    setPickerOpen(false)
    setActiveRefIndex(-1)
  }

  const onRefKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setPickerOpen(false)
      setActiveRefIndex(-1)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (visibleRefs.length === 0) return
      event.preventDefault()
      setPickerOpen(true)
      setActiveRefIndex((current) => {
        if (event.key === 'ArrowDown') return Math.min(current + 1, visibleRefs.length - 1)
        return Math.max(current <= 0 ? 0 : current - 1, 0)
      })
      return
    }
    if (event.key === 'Enter' && pickerOpen && activeRefIndex >= 0) {
      event.preventDefault()
      const selected = visibleRefs[activeRefIndex]
      if (selected !== undefined) chooseRef(selected)
    }
  }

  const inspectDataset = (event: FormEvent) => {
    event.preventDefault()
    if (!EXACT_VERSION.test(datasetVersion) || targetSource === '') return
    inspectController.current?.abort()
    const controller = new AbortController()
    inspectController.current = controller
    inspect.mutate(
      {
        refOrVersion: datasetVersion,
        request: {
          converter: 'evalscope-general-qa',
          options: { target_source: targetSource },
        },
        signal: controller.signal,
      },
      {
        onSuccess: (nextPlan) => {
          if (!controller.signal.aborted && inspectController.current === controller) {
            setPlan(nextPlan)
          }
        },
        onSettled: () => {
          if (inspectController.current === controller) inspectController.current = null
        },
      },
    )
  }

  return (
    <section
      className="space-y-5 border-border border-y py-5"
      aria-label={t('evaluations.tasks.databenchSource')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Database aria-hidden="true" className="text-primary" size={16} />
          <h3 className="font-medium text-sm">{t('evaluations.tasks.databenchDataset')}</h3>
        </div>
        <Badge tone="muted">general_qa</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <TaskFormField id="databench-ref" label={t('evaluations.tasks.ref')}>
          <div className="relative" ref={pickerRef}>
            <TextInput
              aria-activedescendant={
                pickerOpen && activeRefIndex >= 0
                  ? `${refListboxId}-option-${activeRefIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-controls={refListboxId}
              aria-expanded={pickerOpen}
              autoComplete="off"
              disabled={disabled}
              id="databench-ref"
              onChange={(event) => {
                const next = event.currentTarget.value
                setRefSearch(next)
                if (next !== selectedRef?.name) {
                  setSelectedRef(null)
                  setDatasetVersion('')
                }
                setPickerOpen(true)
                setActiveRefIndex(0)
              }}
              onFocus={() => setPickerOpen(true)}
              onKeyDown={onRefKeyDown}
              placeholder={t('evaluations.tasks.searchRef')}
              role="combobox"
              value={refSearch}
            />
            {pickerOpen ? (
              <div
                className="absolute right-0 left-0 z-30 mt-1.5 max-h-64 overflow-auto rounded-[6px] border border-border-strong bg-surface-raised p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.38)]"
                id={refListboxId}
                role="listbox"
              >
                {visibleRefs.map((ref, index) => (
                  <button
                    aria-selected={ref.name === selectedRef?.name}
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-[4px] px-3 text-left text-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                    id={`${refListboxId}-option-${index}`}
                    key={ref.name}
                    onClick={() => chooseRef(ref)}
                    onPointerEnter={() => setActiveRefIndex(index)}
                    role="option"
                    type="button"
                  >
                    <span className="truncate">{ref.name}</span>
                    <span className="shrink-0 font-mono text-dim-foreground text-xs">
                      {formatInteger(ref.num_records)}
                    </span>
                  </button>
                ))}
                {visibleRefs.length === 0 ? (
                  <p className="px-3 py-3 text-muted-foreground text-sm">
                    {refsQuery.isLoading
                      ? t('evaluations.tasks.loadingRefs')
                      : t('evaluations.tasks.noMatchingRef')}
                  </p>
                ) : null}
                {refsQuery.hasNextPage ? (
                  <Button
                    className="mt-1 w-full"
                    disabled={refsQuery.isFetchingNextPage}
                    onClick={() => void refsQuery.fetchNextPage()}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t('evaluations.tasks.loadMoreRefs')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </TaskFormField>

        <TaskFormField id="databench-task-type" label={t('evaluations.tasks.taskType')}>
          <SelectInput
            aria-label={t('evaluations.tasks.taskType')}
            disabled
            id="databench-task-type"
            onValueChange={() => undefined}
            options={[{ label: t('evaluations.tasks.generalQa'), value: 'general-qa' }]}
            value="general-qa"
          />
        </TaskFormField>

        <TaskFormField id="databench-target" label={t('evaluations.tasks.targetSource')}>
          <SelectInput
            aria-label={t('evaluations.tasks.targetSource')}
            disabled={disabled}
            id="databench-target"
            onValueChange={setTargetSource}
            options={[
              {
                disabled: true,
                label: t('evaluations.tasks.selectTargetSource'),
                value: '',
              },
              { label: t('evaluations.tasks.targetSelected'), value: 'selected-candidate' },
              {
                label: t('evaluations.tasks.targetGroundTruth'),
                value: 'verification-ground-truth',
              },
            ]}
            value={targetSource}
          />
        </TaskFormField>

        <TaskFormField id="databench-version" label={t('evaluations.tasks.exactVersion')}>
          <div className="min-h-10 rounded-[4px] border border-border bg-background/45 px-3 py-2.5 font-mono text-xs leading-5">
            {datasetVersion === '' ? t('evaluations.tasks.selectRefFirst') : datasetVersion}
          </div>
        </TaskFormField>
      </div>

      {dataset.isLoading ? (
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {t('evaluations.tasks.loadingDataset')}
        </p>
      ) : null}
      {dataset.isError ? <V2MutationError error={dataset.error} /> : null}
      {refsQuery.isError ? <V2MutationError error={refsQuery.error} /> : null}

      <Button
        disabled={
          disabled ||
          targetSource === '' ||
          !EXACT_VERSION.test(datasetVersion) ||
          dataset.isError ||
          inspect.isPending
        }
        onClick={inspectDataset}
        type="button"
        variant="outline"
      >
        <Search aria-hidden="true" size={15} />
        {inspect.isPending
          ? t('evaluations.tasks.inspecting')
          : t('evaluations.tasks.inspectDataset')}
      </Button>

      {inspect.isError ? <V2MutationError error={inspect.error} /> : null}
      {plan !== null ? (
        <div className="space-y-4">
          {plan.output_count <= 0 ? (
            <Alert className="border-danger/35 bg-danger/10" role="alert">
              {t('evaluations.tasks.noEligibleRecords')}
            </Alert>
          ) : (
            <Alert aria-live="polite">
              <Check aria-hidden="true" className="mr-2 inline text-success" size={15} />
              {t('evaluations.tasks.evaluationSampleCount', {
                count: formatInteger(evaluationSampleCount ?? plan.output_count),
                eligible: formatInteger(plan.output_count),
              })}
            </Alert>
          )}
          <FidelityReview plan={plan} />
          {hasSemanticChanges(plan) ? (
            <label className="flex items-start gap-3 text-sm">
              <input
                checked={confirmed}
                className="mt-0.5 size-5 accent-primary"
                disabled={disabled}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>{t('v2.export.confirmSemantic')}</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
