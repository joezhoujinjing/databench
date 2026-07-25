import { useNavigate } from '@tanstack/react-router'
import { RotateCcw } from 'lucide-react'
import { type FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '@/api/errors.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
import { Field, FormError } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import {
  PageHeader,
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { cn } from '@/lib/utils.js'
import { useV2DatasetResolution, useV2RunTransform, useV2Transforms } from '../../api/hooks.js'
import type { TransformDescriptorV2 } from '../../api/types.js'
import { RefConflictRecovery, readRefConflictDetail } from '../../components/RefConflictRecovery.js'
import { V2MutationError } from '../../components/V2MutationError.js'

export function V2TransformsPageView() {
  const { t } = useTranslation()
  const transforms = useV2Transforms()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const selected = useMemo(
    () =>
      transforms.data?.items.find((item) => item.name === selectedName) ??
      transforms.data?.items[0] ??
      null,
    [selectedName, transforms.data],
  )

  return (
    <PageShell>
      <PageHeader title={t('v2.transforms.title')} />
      <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Surface className="h-fit overflow-hidden">
          <SurfaceHeader>
            <SurfaceTitle>{t('v2.transforms.registry')}</SurfaceTitle>
          </SurfaceHeader>
          {transforms.isLoading ? <Spinner /> : null}
          {transforms.isError ? <ErrorState error={transforms.error} /> : null}
          {transforms.data?.items.length === 0 ? (
            <SurfaceBody>
              <EmptyState>{t('v2.transforms.empty')}</EmptyState>
            </SurfaceBody>
          ) : null}
          {transforms.data?.items.map((item) => (
            <button
              aria-pressed={item.name === selected?.name}
              className={cn(
                'grid w-full gap-2 border-border border-b px-5 py-4 text-left last:border-b-0 hover:bg-surface-hover',
                item.name === selected?.name && 'border-l-2 border-l-primary bg-surface-soft',
              )}
              key={item.name}
              onClick={() => setSelectedName(item.name)}
              type="button"
            >
              <span className="font-medium">{item.name}</span>
              <span className="flex items-center gap-2 text-muted-foreground text-xs">
                <span>{t('v2.transforms.version', { version: item.version })}</span>
                <Badge>
                  {item.identity_mode === 'preserve'
                    ? t('v2.transforms.preserve')
                    : t('v2.transforms.derive')}
                </Badge>
              </span>
            </button>
          ))}
        </Surface>
        {selected ? (
          <RunTransformPanel key={selected.name} transform={selected} />
        ) : (
          <Surface>
            <SurfaceBody>
              <EmptyState>{t('v2.transforms.select')}</EmptyState>
            </SurfaceBody>
          </Surface>
        )}
      </div>
    </PageShell>
  )
}

function RunTransformPanel({ transform }: { transform: TransformDescriptorV2 }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const run = useV2RunTransform()
  const [inputs, setInputs] = useState<OrderedInput[]>(() =>
    createOrderedInputs(transform.input_roles),
  )
  const paramsExample = formatParamsExample(transform.params_example)
  const [paramsText, setParamsText] = useState(paramsExample)
  const [ref, setRef] = useState('')
  const [expectedVersion, setExpectedVersion] = useState('')
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const conflict = readRefConflictDetail(run.error)
  const deferredOutputRef = useDeferredValue(ref.trim())
  const outputResolution = useV2DatasetResolution(deferredOutputRef)
  const controllerRef = useRef<AbortController | null>(null)
  const hasParams = hasTransformParams(transform.params_schema)
  useEffect(() => () => controllerRef.current?.abort(), [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const normalizedInputs = inputs.map((input) => input.value.trim())
    if (normalizedInputs.some((input) => input === '')) {
      setFormError(t('v2.transforms.inputRequired'))
      return
    }
    const params = parseJsonObject(paramsText)
    if (!params.ok) {
      setFormError(
        params.reason === 'not_object'
          ? t('v2.transforms.paramsObject')
          : t('v2.transforms.paramsInvalid', { message: params.message }),
      )
      return
    }
    if (expectedVersion.trim() !== '' && ref.trim() === '') {
      setFormError(t('v2.transforms.expectedNeedsRef'))
      return
    }
    if (message.trim() !== '' && ref.trim() === '') {
      setFormError(t('v2.transforms.messageNeedsRef'))
      return
    }
    setFormError(null)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    run.mutate(
      {
        name: transform.name,
        request: {
          expected_ref_version: blankToNull(expectedVersion),
          inputs: normalizedInputs,
          message: blankToNull(message),
          params: params.value,
          ref: blankToNull(ref),
        },
        signal: controller.signal,
      },
      {
        onSuccess: (result) => {
          if (controller.signal.aborted) return
          void navigate({
            params: { ref: result.manifest.dataset_version },
            to: '/datasets/$ref',
          })
        },
        onSettled: () => {
          if (controllerRef.current === controller) controllerRef.current = null
          if (controller.signal.aborted) run.reset()
        },
      },
    )
  }

  return (
    <Surface className="overflow-hidden">
      <SurfaceHeader>
        <div className="flex flex-wrap items-center gap-3">
          <SurfaceTitle>{transform.name}</SurfaceTitle>
          <Badge>{t('v2.transforms.version', { version: transform.version })}</Badge>
          <Badge>
            {transform.identity_mode === 'preserve'
              ? t('v2.transforms.preserve')
              : t('v2.transforms.derive')}
          </Badge>
        </div>
      </SurfaceHeader>
      <div className="grid lg:grid-cols-[minmax(16rem,0.78fr)_minmax(0,1.65fr)]">
        <aside className="space-y-6 border-border border-b px-5 py-5 lg:border-r lg:border-b-0">
          <div>
            <h3 className="font-semibold text-base">
              {t(`v2.transforms.guidance.${transform.name}.title`, {
                defaultValue: transform.name,
              })}
            </h3>
            <p className="mt-2 text-muted-foreground text-sm leading-6">
              {t(`v2.transforms.guidance.${transform.name}.description`, {
                defaultValue:
                  transform.identity_mode === 'preserve'
                    ? t('v2.transforms.identityPreserve')
                    : t('v2.transforms.identityDerive'),
              })}
            </p>
          </div>
          <TransformFact
            label={t('v2.transforms.inputRequirement')}
            value={t(`v2.transforms.guidance.${transform.name}.inputRequirement`, {
              count: transform.input_roles.length,
              defaultValue: t('v2.transforms.inputRequirementFallback', {
                count: transform.input_roles.length,
              }),
            })}
          />
          <TransformFact
            label={t('v2.transforms.outputResult')}
            value={t(`v2.transforms.guidance.${transform.name}.outputResult`, {
              defaultValue:
                transform.identity_mode === 'preserve'
                  ? t('v2.transforms.identityPreserve')
                  : t('v2.transforms.identityDerive'),
            })}
          />
          {hasParams ? (
            <div>
              <h3 className="font-medium text-muted-foreground text-sm">
                {t('v2.transforms.parameterExample')}
              </h3>
              <div className="mt-3">
                <JsonBlock value={transform.params_example} />
              </div>
              <p className="mt-2 text-dim-foreground text-xs leading-5">
                {t(`v2.transforms.guidance.${transform.name}.paramsNote`, {
                  defaultValue: t('v2.transforms.paramsHint'),
                })}
              </p>
            </div>
          ) : (
            <TransformFact
              label={t('v2.transforms.parameters')}
              value={t(`v2.transforms.guidance.${transform.name}.paramsNote`, {
                defaultValue: t('v2.transforms.noParamsBody'),
              })}
            />
          )}
        </aside>

        <form className="space-y-5 px-5 py-5" onSubmit={submit}>
          <div className="space-y-4">
            {inputs.map((input, index) => (
              <Field
                hint={t(`v2.transforms.guidance.${transform.name}.roles.${input.role}.hint`, {
                  defaultValue: t('v2.transforms.inputRoleHint'),
                })}
                key={input.id}
                label={t(`v2.transforms.guidance.${transform.name}.roles.${input.role}.label`, {
                  defaultValue: input.role,
                })}
              >
                <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] overflow-hidden rounded-[4px] border border-border bg-background/70 focus-within:border-primary focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_72%,transparent)]">
                  <span className="flex items-center justify-center border-border border-r text-dim-foreground text-sm">
                    {index + 1}
                  </span>
                  <TextInput
                    className="rounded-none border-0 bg-transparent focus:shadow-none"
                    aria-label={t('v2.transforms.inputNumber', { number: index + 1 })}
                    onChange={(event) => {
                      const nextValue = event.currentTarget.value
                      setInputs((current) =>
                        current.map((value, itemIndex) =>
                          itemIndex === index ? { ...value, value: nextValue } : value,
                        ),
                      )
                    }}
                    placeholder={t('v2.transforms.inputPlaceholder')}
                    value={input.value}
                  />
                </div>
              </Field>
            ))}
          </div>
          {hasParams ? (
            <>
              <Field
                hint={t(`v2.transforms.guidance.${transform.name}.paramsNote`, {
                  defaultValue: t('v2.transforms.paramsHint'),
                })}
                label={t('v2.transforms.params')}
              >
                <CodeEditor
                  aria-label={t('v2.transforms.params')}
                  header={
                    <Button
                      onClick={() => setParamsText(paramsExample)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <RotateCcw aria-hidden="true" size={14} />
                      {t('v2.transforms.resetExample')}
                    </Button>
                  }
                  language="JSON"
                  minRows={7}
                  onChange={(event) => setParamsText(event.currentTarget.value)}
                  value={paramsText}
                />
              </Field>
              <details>
                <summary className="cursor-pointer text-muted-foreground text-sm">
                  {t('v2.transforms.schema')}
                </summary>
                <div className="mt-3">
                  <JsonBlock value={transform.params_schema} />
                </div>
              </details>
            </>
          ) : (
            <div className="rounded-[5px] border border-border bg-surface-soft px-4 py-5">
              <div className="font-medium text-sm">{t('v2.transforms.noParams')}</div>
              <p className="mt-2 text-dim-foreground text-xs leading-5">
                {t(`v2.transforms.guidance.${transform.name}.paramsNote`, {
                  defaultValue: t('v2.transforms.noParamsBody'),
                })}
              </p>
            </div>
          )}
          <div className="space-y-4 border-border border-t pt-5">
            <h3 className="font-medium text-muted-foreground text-sm">
              {t('v2.transforms.resultOptions')}
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('v2.transforms.outputRef')}>
                <TextInput
                  aria-label={t('v2.transforms.outputRef')}
                  onChange={(event) => setRef(event.currentTarget.value)}
                  value={ref}
                />
              </Field>
              <Field hint={t('v2.transforms.expectedHint')} label={t('v2.transforms.expected')}>
                <TextInput
                  aria-label={t('v2.transforms.expected')}
                  disabled={ref.trim() === ''}
                  onChange={(event) => setExpectedVersion(event.currentTarget.value)}
                  value={expectedVersion}
                />
              </Field>
            </div>
            {deferredOutputRef === '' ? null : (
              <CurrentOutputRef
                error={outputResolution.error}
                isError={outputResolution.isError}
                isFetching={outputResolution.isFetching}
                onUse={(version) => setExpectedVersion(version)}
                version={outputResolution.data?.dataset_version ?? null}
              />
            )}
            <Field label={t('v2.transforms.message')}>
              <TextInput
                aria-label={t('v2.transforms.message')}
                disabled={ref.trim() === ''}
                onChange={(event) => setMessage(event.currentTarget.value)}
                value={message}
              />
            </Field>
          </div>
          {formError ? <FormError>{formError}</FormError> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={run.isPending} type="submit">
              {run.isPending ? t('v2.transforms.running') : t('v2.transforms.run')}
            </Button>
            {run.isPending ? (
              <Button
                onClick={() => controllerRef.current?.abort()}
                type="button"
                variant="outline"
              >
                {t('v2.transforms.cancel')}
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      {run.isError ? (
        <SurfaceBody className="border-border border-t">
          {conflict ? (
            <RefConflictRecovery
              error={run.error}
              onResolved={(version) => {
                void navigate({ params: { ref: version }, to: '/datasets/$ref' })
              }}
            />
          ) : (
            <V2MutationError error={run.error} />
          )}
        </SurfaceBody>
      ) : null}
    </Surface>
  )
}

interface OrderedInput {
  id: string
  role: string
  value: string
}

function TransformFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border border-t pt-5">
      <h3 className="font-medium text-muted-foreground text-sm">{label}</h3>
      <p className="mt-2 text-sm leading-6">{value}</p>
    </div>
  )
}

function CurrentOutputRef({
  error,
  isError,
  isFetching,
  onUse,
  version,
}: {
  error: unknown
  isError: boolean
  isFetching: boolean
  onUse(version: string): void
  version: string | null
}) {
  const { t } = useTranslation()
  if (isFetching && version === null) {
    return <div className="text-muted-foreground text-sm">{t('v2.transforms.resolvingRef')}</div>
  }
  if (isError && isApiError(error) && error.code === 'not_found') {
    return <div className="text-muted-foreground text-sm">{t('v2.transforms.newRef')}</div>
  }
  if (isError) {
    return <div className="text-danger text-sm">{t('v2.transforms.refLookupFailed')}</div>
  }
  if (version === null) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[5px] border border-border bg-surface-soft p-3 text-sm">
      <span>
        {t('v2.transforms.currentRef')} <code className="break-all text-xs">{version}</code>
      </span>
      <Button onClick={() => onUse(version)} size="sm" type="button" variant="outline">
        {t('v2.transforms.useCurrent')}
      </Button>
    </div>
  )
}

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { message: string; ok: false; reason: 'invalid_json' }
  | { ok: false; reason: 'not_object' }

export function parseJsonObject(text: string): JsonObjectParseResult {
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'not_object' }
    }
    return { ok: true, value: value as Record<string, unknown> }
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      reason: 'invalid_json',
    }
  }
}

export function createOrderedInputs(inputRoles: readonly string[]): OrderedInput[] {
  return inputRoles.map((role, index) => ({
    id: `${role}-${index + 1}`,
    role,
    value: '',
  }))
}

export function formatParamsExample(paramsExample: Record<string, unknown>): string {
  return JSON.stringify(paramsExample, null, 2)
}

export function hasTransformParams(paramsSchema: Record<string, unknown>): boolean {
  const properties = paramsSchema.properties
  return (
    properties !== null &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    Object.keys(properties).length > 0
  )
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
