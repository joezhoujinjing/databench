import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Term } from '@/api/types.js'
import { Button } from '@/components/ui/button.js'
import { Field } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import { Toolbar } from '@/components/ui/surface.js'
import { parseAliases, VirtualizedTerms } from './VirtualizedTerms.js'

export function TermsEditor({
  onChange,
  terms,
}: {
  onChange: (terms: Term[]) => void
  terms: readonly Term[]
}) {
  const { t } = useTranslation()
  const [canonical, setCanonical] = useState('')
  const [aliases, setAliases] = useState('')

  function addTerm() {
    const nextCanonical = canonical.trim()

    if (nextCanonical === '') {
      return
    }

    onChange([
      {
        aliases: parseAliases(aliases),
        canonical: nextCanonical,
        meta: {},
      },
      ...terms,
    ])
    setCanonical('')
    setAliases('')
  }

  function changeCanonical(index: number, nextCanonical: string) {
    onChange(
      terms.map((term, termIndex) =>
        termIndex === index ? { ...term, canonical: nextCanonical } : term,
      ),
    )
  }

  function changeAliases(index: number, nextAliases: string[]) {
    onChange(
      terms.map((term, termIndex) =>
        termIndex === index ? { ...term, aliases: nextAliases } : term,
      ),
    )
  }

  function removeTerm(index: number) {
    onChange(terms.filter((_term, termIndex) => termIndex !== index))
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[minmax(10rem,0.45fr)_minmax(0,1fr)_auto] md:items-end">
        <Field label={t('vocab.canonicalPlaceholder')}>
          <TextInput
            onChange={(event) => setCanonical(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addTerm()
              }
            }}
            placeholder={t('vocab.canonicalPlaceholder')}
            value={canonical}
          />
        </Field>
        <Field label={t('vocab.aliasesPlaceholder')}>
          <TextInput
            onChange={(event) => setAliases(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addTerm()
              }
            }}
            placeholder={t('vocab.aliasesPlaceholder')}
            value={aliases}
          />
        </Field>
        <Toolbar className="md:pb-0">
          <Button
            disabled={canonical.trim() === ''}
            onClick={addTerm}
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" size={16} />
            {t('vocab.addTerm')}
          </Button>
        </Toolbar>
      </div>

      <VirtualizedTerms
        editing
        onAliasesChange={changeAliases}
        onCanonicalChange={changeCanonical}
        onRemoveTerm={removeTerm}
        terms={terms}
      />
    </div>
  )
}
