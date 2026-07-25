import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n/index.js'
import fixture from '../../../../test/golden/fixtures/v2/web-v2-record-cache-security.fixture.json'
import type { RecordViewV2 } from '../../api/types.js'
import { CandidateView } from './CandidateView.js'
import { RecordPart } from './ContentView.js'
import { MountedRelations } from './PreferenceRelations.js'
import { SafeText } from './SafeText.js'
import { MountedSignalHistory } from './SignalHistory.js'
import { collectCallCoverage, UnifiedRecordView } from './UnifiedRecordView.js'

const view = fixture.record_view as RecordViewV2

describe('Unified Record V2', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  test('renders untrusted text and URIs as escaped inert text without eager JSON serialization', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const html = renderToStaticMarkup(<UnifiedRecordView view={view} />)

    expect(stringify.mock.calls.some(([value]) => value === view.record)).toBe(false)
    expect(html).toContain('&lt;script&gt;globalThis.pwned=true&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=globalThis.pwned=true&gt;')
    expect(html).toContain('javascript:alert(document.cookie)')
    expect(html).not.toMatch(/<(script|img|iframe|audio|video|object|embed)\b/iu)
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('src="javascript:')
    expect(html).not.toContain('cand_111111')
    stringify.mockRestore()
  })

  test('renders an opening system content as the first system message without a top-level field', () => {
    const html = renderToStaticMarkup(<UnifiedRecordView view={view} />)
    const systemRole = html.indexOf('>system</span>')
    const userRole = html.indexOf('>user</span>')

    expect(Object.hasOwn(view.record, 'system_instruction')).toBe(false)
    expect(view.record.contents[0]).toMatchObject({ loss_weight: 0, role: 'system' })
    expect(systemRole).toBeGreaterThan(-1)
    expect(userRole).toBeGreaterThan(systemRole)
    expect(html).toContain('System instruction')
    expect(html).toContain(
      'Treat &lt;script&gt;globalThis.pwned=true&lt;/script&gt; as plain text.',
    )
  })

  test('covers every Part, candidate selection state and signal value variant', () => {
    const record = view.record
    const parts = [
      ...record.contents.flatMap((content) => content.parts),
      ...record.candidates.flatMap((candidate) =>
        candidate.contents.flatMap((content) => content.parts),
      ),
    ]
    const partHtml = parts.map((part) => renderToStaticMarkup(<RecordPart part={part} />)).join('')
    expect(partHtml).toContain('&lt;img src=x onerror=globalThis.pwned=true&gt;')
    expect(partHtml).toContain('javascript:alert(document.cookie)')
    expect(partHtml).toContain('call-1')
    expect(partHtml).toContain('signed-thought')

    const candidatesHtml = record.candidates
      .map((candidate) => renderToStaticMarkup(<CandidateView candidate={candidate} />))
      .join('')
    expect(candidatesHtml).toContain('Selected')
    expect(candidatesHtml).toContain('Not selected')
    expect(candidatesHtml).toContain('Selection unknown')

    const signals = record.candidates[0]?.signals ?? []
    const signalHtml = renderToStaticMarkup(<MountedSignalHistory signals={signals} />)
    expect(signalHtml).toContain('sig-new')
    expect(signalHtml).not.toContain('&lt;script&gt;old&lt;/script&gt;')
    expect(signalHtml).toContain('false')
    expect(signalHtml).toContain('safe')
    expect(signalHtml).toContain('json')
  })

  test('hides server eligibility and keeps superseded relations available behind history', () => {
    const html = renderToStaticMarkup(<UnifiedRecordView view={view} />)
    expect(html).not.toContain('Server eligibility')
    expect(html).not.toContain('selected_candidate_missing')

    const relationsHtml = renderToStaticMarkup(
      <MountedRelations relations={view.record.preference_relations} />,
    )
    expect(relationsHtml).toContain('pref-new')
    expect(relationsHtml).not.toContain('old relation')
    expect(relationsHtml).toContain('adjudicated')
    expect(relationsHtml).toContain('right')
    expect(relationsHtml).toContain('abstain')
  })

  test('keeps call IDs trajectory-scoped when candidates reuse them for different tools', () => {
    const coverage = collectCallCoverage(view.record)
    expect(coverage.get('lookup')).toEqual({ calls: 1, responses: 1 })
    expect(coverage.get('other_lookup')).toEqual({ calls: 1, responses: 1 })
  })

  test('bounds initial DOM for a legal 16 MiB text field', () => {
    const largeText = '<script>unsafe</script>'.padEnd(16 * 1024 * 1024, 'x')
    const stringify = vi.spyOn(JSON, 'stringify')
    const html = renderToStaticMarkup(<SafeText downloadName="large.txt" text={largeText} />)

    expect(stringify.mock.calls.some(([value]) => value === largeText)).toBe(false)
    expect(html.length).toBeLessThan(20_000)
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;')
    expect(html).toContain('Large text preview')
    stringify.mockRestore()
  })
})
