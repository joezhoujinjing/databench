import { describe, expect, test } from 'vitest'
import {
  installSwiftStudioPresentation,
  isSwiftStudioFrameBooted,
  resolveSwiftStudioFrameLocation,
  shouldRenderSwiftStudioFrame,
  toggleSwiftStudioFullscreen,
} from './frame.js'

const READY_SNAPSHOT = {
  appElementPresent: true,
  customElementRegistered: true,
  gradioConfig: {
    api_prefix: '/gradio_api',
    mode: 'blocks',
    root: 'http://swift-studio:7860/swift-studio',
    version: '5.50.0',
  },
  origin: 'https://databench.example.test',
}

describe('Swift Studio iframe boundary', () => {
  test('always uses the fixed same-origin Studio path for relative or same-origin API bases', () => {
    expect(resolveSwiftStudioFrameLocation('', 'https://databench.example.test')).toEqual({
      source: '/swift-studio/',
      supported: true,
    })
    expect(resolveSwiftStudioFrameLocation('/api', 'https://databench.example.test')).toEqual({
      source: '/swift-studio/',
      supported: true,
    })
    expect(
      resolveSwiftStudioFrameLocation(
        'https://databench.example.test/api',
        'https://databench.example.test',
      ),
    ).toEqual({ source: '/swift-studio/', supported: true })
  })

  test('fails closed for a cross-origin API because iframe auth and SAMEORIGIN cannot work', () => {
    expect(
      resolveSwiftStudioFrameLocation('https://api.example.test', 'https://databench.example.test'),
    ).toEqual({ reason: 'cross-origin', supported: false })
  })

  test('fails closed when the selected backend requires a bearer token', () => {
    expect(
      resolveSwiftStudioFrameLocation('/api', 'https://databench.example.test', 'scoped-token'),
    ).toEqual({ reason: 'bearer-token', supported: false })
  })

  test('does not preserve a stale ready iframe after a runtime refetch fails', () => {
    expect(
      shouldRenderSwiftStudioFrame({
        frameLocation: { source: '/swift-studio/', supported: true },
        querySucceeded: false,
        runtimeReady: true,
      }),
    ).toBe(false)
  })

  test('hides only the locked upstream title components and installs the style once', () => {
    const elements = new Map<string, { id: string; textContent: string | null }>()
    const appended: Array<{ id: string; textContent: string | null }> = []
    const documentRef = {
      createElement: () => ({ id: '', textContent: null }),
      getElementById: (id: string) => elements.get(id) ?? null,
      head: {
        append: (element: { id: string; textContent: string | null }) => {
          appended.push(element)
          elements.set(element.id, element)
        },
      },
    } as unknown as Document

    expect(installSwiftStudioPresentation(documentRef)).toBe(true)
    expect(installSwiftStudioPresentation(documentRef)).toBe(true)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.textContent).toContain('#component-1')
    expect(appended[0]?.textContent).toContain('#component-2')
    expect(appended[0]?.textContent).not.toContain('#component-3')
  })

  test('contains fullscreen rejection and reports failure', async () => {
    const container = {
      requestFullscreen: async () => {
        throw new Error('denied')
      },
    }
    await expect(
      toggleSwiftStudioFullscreen(
        { exitFullscreen: async () => undefined, fullscreenElement: null },
        container,
      ),
    ).resolves.toBe(false)
  })

  test('requires the locked config, root path, app element, and registered custom element', () => {
    expect(isSwiftStudioFrameBooted(READY_SNAPSHOT)).toBe(true)
    expect(isSwiftStudioFrameBooted({ ...READY_SNAPSHOT, appElementPresent: false })).toBe(false)
    expect(isSwiftStudioFrameBooted({ ...READY_SNAPSHOT, customElementRegistered: false })).toBe(
      false,
    )
    expect(
      isSwiftStudioFrameBooted({
        ...READY_SNAPSHOT,
        gradioConfig: { ...READY_SNAPSHOT.gradioConfig, root: '/other' },
      }),
    ).toBe(false)
    expect(
      isSwiftStudioFrameBooted({
        ...READY_SNAPSHOT,
        gradioConfig: { ...READY_SNAPSHOT.gradioConfig, version: 'drifted' },
      }),
    ).toBe(false)
  })
})
