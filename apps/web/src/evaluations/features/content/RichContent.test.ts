import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RichContent, resolveSafeMediaSource } from './RichContent.js'

describe('EvalScope rich-content media sources', () => {
  it('accepts reviewed data URIs and raw base64 containing slash characters', () => {
    const raw = `${'a'.repeat(60)}/+A=`
    expect(resolveSafeMediaSource(raw, 'image', 'png')).toBe(`data:image/png;base64,${raw}`)
    expect(resolveSafeMediaSource('data:audio/ogg;base64,T2dnUw==', 'audio')).toBe(
      'data:audio/ogg;base64,T2dnUw==',
    )
  })

  it('routes only safe relative locators through the media gateway', () => {
    expect(resolveSafeMediaSource('images/result.png', 'image')).toContain(
      '/reports/media/file?path=images%2Fresult.png',
    )
    expect(resolveSafeMediaSource('../secret.png', 'image')).toBeNull()
    expect(resolveSafeMediaSource('/etc/passwd', 'image')).toBeNull()
  })

  it('blocks external, protocol-relative and active data URLs', () => {
    expect(resolveSafeMediaSource('https://example.com/result.png', 'image')).toBeNull()
    expect(resolveSafeMediaSource('//example.com/result.png', 'image')).toBeNull()
    expect(resolveSafeMediaSource('data:image/svg+xml;base64,PHN2Zz4=', 'image')).toBeNull()
    expect(resolveSafeMediaSource('javascript:alert(1)', 'image')).toBeNull()
  })

  it('does not interpret ordinary currency spans as inline math', () => {
    const html = renderToStaticMarkup(
      createElement(RichContent, {
        content: 'Weng earns $12 an hour and received $10 yesterday.',
      }),
    )
    expect(html).toContain('$12 an hour and received $10')
    expect(html).not.toContain('class="katex"')
  })
})
