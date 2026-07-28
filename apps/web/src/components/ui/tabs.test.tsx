import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { moveTabIndex, Tabs } from './tabs.js'

describe('Databench tabs primitive', () => {
  test('renders a connected WAI-ARIA tab and panel model', () => {
    const html = renderToStaticMarkup(
      <Tabs
        ariaLabel="Task type"
        items={[
          { label: 'Evaluation', value: 'eval', panel: <p>Evaluation form</p> },
          { label: 'Performance', value: 'perf', panel: <p>Performance form</p> },
        ]}
        onChange={() => undefined}
        value="eval"
      />,
    )

    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/gu)).toHaveLength(2)
    expect(html.match(/role="tabpanel"/gu)).toHaveLength(2)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-controls=')
    expect(html).toContain('aria-labelledby=')
  })

  test('supports wrapping arrow navigation and Home/End', () => {
    expect(moveTabIndex(0, 3, 'ArrowLeft')).toBe(2)
    expect(moveTabIndex(2, 3, 'ArrowRight')).toBe(0)
    expect(moveTabIndex(2, 3, 'Home')).toBe(0)
    expect(moveTabIndex(0, 3, 'End')).toBe(2)
    expect(moveTabIndex(0, 3, 'Enter')).toBeNull()
  })
})
