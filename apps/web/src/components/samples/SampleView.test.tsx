import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test } from 'vitest'
import type { Sample } from '@/api/types.js'
import i18n from '@/i18n/index.js'
import { SampleView } from './SampleView.js'

describe('SampleView', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  test('renders sft messages and optional sample id', () => {
    const html = renderToStaticMarkup(
      <SampleView
        sample={
          {
            id: 'sample-1',
            kind: 'sft',
            messages: [message('user', 'hello')],
          } as unknown as Sample
        }
      />,
    )

    expect(html).toContain('sample-1')
    expect(html).toContain('user')
    expect(html).toContain('hello')
  })

  test('keeps legacy-tolerant reward and trajectory step previews', () => {
    const rl = renderToStaticMarkup(
      <SampleView sample={{ kind: 'rl', reward: 1.5 } as unknown as Sample} />,
    )
    const trajectory = renderToStaticMarkup(
      <SampleView
        sample={
          { kind: 'trajectory', steps: [{ op: 'tool' }, { op: 'final' }] } as unknown as Sample
        }
      />,
    )

    expect(rl).toContain('reward')
    expect(rl).toContain('1.5')
    expect(trajectory).toContain('2 step(s)')
  })
})

function message(role: 'system' | 'user' | 'assistant' | 'tool', content: string | null) {
  return {
    content,
    name: null,
    role,
    tool_call_id: null,
    tool_calls: null,
  }
}
