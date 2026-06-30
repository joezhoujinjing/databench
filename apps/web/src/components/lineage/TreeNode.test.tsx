import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { TreeNode } from './TreeNode.js'

describe('TreeNode', () => {
  test('renders expanded object children with aria-expanded', () => {
    const html = renderToStaticMarkup(
      <TreeNode
        defaultOpen
        label="lineage"
        value={{ inputs: [{ version: 'v1' }], version: 'v2' }}
      />,
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('inputs')
    expect(html).toContain('version')
    expect(html).toContain('v2')
  })
})
