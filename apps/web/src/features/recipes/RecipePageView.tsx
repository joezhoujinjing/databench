import { Copy, Database, ExternalLink, Maximize2, Share2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMaterializeRecipe } from '@/api/hooks.js'
import type { MaterializeRequest } from '@/api/types.js'
import { InlineError } from '@/components/common/State.js'
import { ManifestView } from '@/components/datasets/ManifestView.js'
import { KindBadge, StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
import { Field, FormError } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import {
  PageHeader,
  PageShell,
  SectionLabel,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { formatInteger } from '@/lib/format.js'

const PLACEHOLDER = `{
  "name": "train-mixture-v3",
  "description": "SFT + preference mixture for model training",
  "version": "3",
  "seed": 42,
  "target_size": 10000000,
  "sources": [
    {
      "ref": "raw-sft@9f6e9d5c0838",
      "weight": 1.0,
      "sample_types": ["sft"],
      "filters": { "min_tokens": 16, "max_tokens": 4096 }
    },
    {
      "ref": "preference@1a2b3c4d5e6f",
      "weight": 0.3,
      "sample_types": ["preference"],
      "filters": { "min_tokens": 8 }
    },
    {
      "ref": "clean@3b1c7a2d91f0",
      "weight": 2.0,
      "sample_types": ["sft"]
    }
  ]
}`

export function RecipePageView() {
  const { t } = useTranslation()
  const materialize = useMaterializeRecipe()
  const [text, setText] = useState(PLACEHOLDER)
  const [ref, setRef] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const parsed = useMemo(() => parseRecipeJson(text), [text])

  function submit(event: FormEvent) {
    event.preventDefault()

    if (!parsed.ok) {
      setFormError(
        parsed.reason === 'not_object'
          ? t('recipe.errRecipeObject')
          : t('recipe.errInvalidJson', { message: parsed.message }),
      )
      return
    }

    setFormError(null)
    materialize.mutate({ payload: { recipe: parsed.recipe, ref: blankToNull(ref) } })
  }

  function validate() {
    if (parsed.ok) {
      setFormError(null)
      return
    }

    setFormError(
      parsed.reason === 'not_object'
        ? t('recipe.errRecipeObject')
        : t('recipe.errInvalidJson', { message: parsed.message }),
    )
  }

  return (
    <PageShell>
      <PageHeader
        actions={<Button variant="quiet">Docs</Button>}
        description={t('recipe.description')}
        title={t('recipe.title')}
      />
      <form className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_32rem]" onSubmit={submit}>
        <Surface className="overflow-hidden">
          <CodeEditor
            aria-label="Recipe editor"
            className="border-0"
            header={
              <>
                <Button size="sm" type="button" variant="outline">
                  JSON
                </Button>
                <Button aria-label="Fullscreen" size="sm" type="button" variant="ghost">
                  <Maximize2 aria-hidden="true" size={16} />
                </Button>
              </>
            }
            language="Recipe editor"
            maxRows={24}
            minRows={24}
            onChange={(event) => setText(event.currentTarget.value)}
            value={text}
          />
        </Surface>

        <Surface className="h-fit">
          <SurfaceHeader>
            <SectionLabel>Live preview</SectionLabel>
          </SurfaceHeader>
          <SurfaceBody className="space-y-6">
            <RecipePreview parsed={parsed} />
            <Field label={t('recipe.outputRefLabel')}>
              <div className="relative">
                <TextInput onChange={(event) => setRef(event.currentTarget.value)} value={ref} />
                <Copy
                  aria-hidden="true"
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-dim-foreground"
                  size={16}
                />
              </div>
            </Field>
            {formError ? <FormError>{formError}</FormError> : null}
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <Button disabled={text.trim() === '' || materialize.isPending} type="submit">
                {materialize.isPending ? t('recipe.materializing') : t('recipe.materializeAction')}
              </Button>
              <Button onClick={validate} type="button" variant="outline">
                Validate
              </Button>
            </div>
            {materialize.isError ? <InlineError error={materialize.error} /> : null}
          </SurfaceBody>
        </Surface>
      </form>

      {parsed.ok ? <ResultPreview outputRef={ref} parsed={parsed} /> : null}

      {materialize.data ? (
        <Surface>
          <SurfaceHeader>
            <SurfaceTitle>{t('recipe.materialized')}</SurfaceTitle>
          </SurfaceHeader>
          <SurfaceBody>
            <ManifestView linkToDetail manifest={materialize.data} />
          </SurfaceBody>
        </Surface>
      ) : null}
    </PageShell>
  )
}

function RecipePreview({ parsed }: { parsed: RecipeParseResult }) {
  if (!parsed.ok) {
    return (
      <div className="rounded-[5px] border border-danger/35 bg-danger/10 p-4 text-danger text-sm">
        Invalid recipe JSON
      </div>
    )
  }

  const recipe = parsed.recipe as Record<string, unknown>
  const sources = Array.isArray(recipe.sources) ? recipe.sources : []
  const name = typeof recipe.name === 'string' ? recipe.name : 'untitled-recipe'
  const seed = typeof recipe.seed === 'number' ? recipe.seed : '-'
  const targetSize = typeof recipe.target_size === 'number' ? recipe.target_size : 10_000_000
  const totalWeight = sources.reduce((sum, source) => {
    const record = source as Record<string, unknown>
    const weight = typeof record.weight === 'number' ? record.weight : 1
    return sum + weight
  }, 0)

  return (
    <div className="space-y-6">
      <div className="grid gap-3 text-sm">
        <PreviewRow label="Recipe name" value={name} />
        <PreviewRow label="Seed" value={seed} />
        <PreviewRow label="Target size (rows)" value={formatInteger(targetSize)} />
        <PreviewRow
          label="Sample types"
          value={
            <div className="flex gap-2">
              <KindBadge kind="sft" />
              <KindBadge kind="preference" />
            </div>
          }
        />
        <PreviewRow
          label="Deterministic"
          value={
            <span className="inline-flex items-center gap-2">
              <StatusDot /> Yes
            </span>
          }
        />
      </div>
      <div className="border-border border-t pt-6">
        <div className="mb-4 flex items-center justify-between gap-3 text-sm">
          <SectionLabel>Sources</SectionLabel>
          <span className="text-muted-foreground">Total weight: {totalWeight.toFixed(2)}</span>
        </div>
        <div className="grid gap-0 text-sm">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem_5rem] gap-3 border-border border-b pb-2 text-muted-foreground text-xs">
            <span>Source ref</span>
            <span>Types</span>
            <span>Weight</span>
          </div>
          {sources.map((source, index) => {
            const record = source as Record<string, unknown>
            return (
              <div
                className="grid gap-3 border-border border-b py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_7rem_5rem]"
                key={sourceKey(record, index)}
              >
                <span className="min-w-0 truncate text-muted-foreground">
                  {String(record.dataset ?? record.ref ?? `source-${index + 1}`)}
                </span>
                <span className="flex flex-wrap gap-2">
                  {sampleTypes(record).map((type) => (
                    <KindBadge kind={type} key={type} />
                  ))}
                </span>
                <span>{String(record.weight ?? 1)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ResultPreview({
  outputRef,
  parsed,
}: {
  outputRef: string
  parsed: Extract<RecipeParseResult, { ok: true }>
}) {
  const recipe = parsed.recipe as Record<string, unknown>
  const sources = Array.isArray(recipe.sources) ? recipe.sources : []
  const name = typeof recipe.name === 'string' ? recipe.name : 'train-mixture'
  const targetSize = typeof recipe.target_size === 'number' ? recipe.target_size : 10_000_000
  const version = outputRef.trim() || 'recipe@7e8f9a0b1c2d'

  return (
    <Surface>
      <SurfaceHeader>
        <SectionLabel>Result preview</SectionLabel>
      </SurfaceHeader>
      <SurfaceBody className="grid gap-4 md:grid-cols-[minmax(12rem,1.4fr)_minmax(10rem,1.1fr)_minmax(8rem,0.8fr)_minmax(9rem,0.8fr)_minmax(9rem,0.8fr)_minmax(10rem,0.9fr)]">
        <ResultCell
          label="Dataset"
          value={
            <span className="inline-flex items-center gap-3">
              <Database aria-hidden="true" className="text-muted-foreground" size={18} />
              <span>{name}</span>
              <KindBadge kind="Ready" />
            </span>
          }
        />
        <ResultCell
          label="Version"
          value={
            <span className="inline-flex min-w-0 items-center gap-2">
              <code className="min-w-0 truncate">{version}</code>
              <Copy aria-hidden="true" className="shrink-0 text-dim-foreground" size={15} />
            </span>
          }
        />
        <ResultCell label="Rows" value={formatInteger(targetSize)} />
        <ResultCell
          label="Kinds"
          value={
            <span className="flex flex-wrap gap-2">
              <KindBadge kind="sft" />
              <KindBadge kind="preference" />
            </span>
          }
        />
        <ResultCell
          label="Lineage"
          value={
            <span className="inline-flex items-center gap-2">
              {sources.length} sources
              <Share2 aria-hidden="true" className="text-dim-foreground" size={15} />
            </span>
          }
        />
        <ResultCell
          label="Samples"
          value={
            <span className="inline-flex items-center gap-2 text-accent-foreground">
              Preview samples
              <ExternalLink aria-hidden="true" size={14} />
            </span>
          }
        />
      </SurfaceBody>
    </Surface>
  )
}

function ResultCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 border-border border-b pb-3 last:border-b-0 md:border-r md:border-b-0 md:pr-4 md:last:border-r-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-2 min-w-0 text-sm leading-6">{value}</div>
    </div>
  )
}

function PreviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  )
}

function sourceKey(record: Record<string, unknown>, index: number): string {
  return String(record.dataset ?? record.ref ?? index)
}

function sampleTypes(record: Record<string, unknown>): string[] {
  const value = record.sample_types

  if (!Array.isArray(value) || value.length === 0) {
    return ['sft']
  }

  return value.map(String)
}

export type RecipeParseResult =
  | { ok: true; recipe: MaterializeRequest['recipe'] }
  | { ok: false; message: string; reason: 'invalid_json' }
  | { ok: false; reason: 'not_object' }

export function parseRecipeJson(text: string): RecipeParseResult {
  try {
    const parsed = JSON.parse(text) as unknown

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not_object' }
    }

    return { ok: true, recipe: parsed as MaterializeRequest['recipe'] }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      reason: 'invalid_json',
    }
  }
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
