import { describe, expect, test } from 'vitest'
import {
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
