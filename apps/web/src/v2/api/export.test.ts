import { describe, expect, test, vi } from 'vitest'
import fixture from '../../../test/golden/fixtures/v2/web-v2-mutations-export.fixture.json'
import {
  assertContentType,
  downloadExportV2,
  ExportDownloadError,
  exportCliCommand,
  responseFilename,
} from './export.js'
import type { ExportPlanV2 } from './types.js'

const plan = fixture.export_plan as ExportPlanV2

describe('V2 export streaming', () => {
  test('uses the versionless product CLI command', () => {
    expect(exportCliCommand(plan)).toMatch(/^databench dataset export /u)
    expect(exportCliCommand(plan)).not.toContain('databench v2')
  })

  test('streams to a file only after a matching successful response', async () => {
    const writes: Uint8Array[] = []
    const writable = {
      abort: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      write: vi.fn(async (value: Uint8Array) => {
        writes.push(value)
      }),
    }
    const result = await downloadExportV2({
      base: 'https://api.example.test',
      fetch: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': plan.media_type },
        }),
      plan,
      target: {
        handle: { createWritable: vi.fn(async () => writable) },
        kind: 'file-system',
      },
      token: 'secret',
    })

    expect(result.bytes).toBe(3)
    expect(writes).toHaveLength(1)
    expect(writable.close).toHaveBeenCalledOnce()
    expect(writable.abort).not.toHaveBeenCalled()
  })

  test('rejects mismatched Content-Type before opening the writable', async () => {
    const createWritable = vi.fn()
    await expect(
      downloadExportV2({
        base: 'https://api.example.test',
        fetch: async () => new Response('bad', { headers: { 'Content-Type': 'text/html' } }),
        plan,
        target: { handle: { createWritable }, kind: 'file-system' },
        token: '',
      }),
    ).rejects.toMatchObject({ code: 'content_type' })
    expect(createWritable).not.toHaveBeenCalled()
  })

  test('enforces the Blob limit from accumulated bytes with missing or wrong Content-Length', async () => {
    for (const contentLength of [undefined, '1']) {
      await expect(
        downloadExportV2({
          base: 'https://api.example.test',
          blobLimitBytes: 2,
          fetch: async () =>
            new Response(new Uint8Array([1, 2, 3]), {
              headers: {
                ...(contentLength === undefined ? {} : { 'Content-Length': contentLength }),
                'Content-Type': plan.media_type,
              },
            }),
          plan,
          target: { kind: 'blob' },
          token: '',
        }),
      ).rejects.toMatchObject({
        cliCommand: exportCliCommand(plan),
        code: 'size_limit',
      })
    }
  })

  test('aborts a partial file and never reports success when reading fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.error(new Error('disconnected'))
      },
    })
    const writable = {
      abort: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    }
    await expect(
      downloadExportV2({
        base: 'https://api.example.test',
        fetch: async () => new Response(stream, { headers: { 'Content-Type': plan.media_type } }),
        plan,
        target: {
          handle: { createWritable: vi.fn(async () => writable) },
          kind: 'file-system',
        },
        token: '',
      }),
    ).rejects.toMatchObject({ code: 'stream_failed' })
    expect(writable.abort).toHaveBeenCalledOnce()
    expect(writable.close).not.toHaveBeenCalled()
  })

  test('propagates user cancellation to a writer even when the fetch stub ignores the signal', async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>()
    const writable = {
      abort: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    }
    let notifyWriterReady: (() => void) | undefined
    const writerReady = new Promise<void>((resolve) => {
      notifyWriterReady = resolve
    })
    const pending = downloadExportV2({
      base: 'https://api.example.test',
      fetch: async () => new Response(stream, { headers: { 'Content-Type': plan.media_type } }),
      plan,
      signal: controller.signal,
      target: {
        handle: {
          createWritable: vi.fn(async () => {
            notifyWriterReady?.()
            return writable
          }),
        },
        kind: 'file-system',
      },
      token: '',
    })
    await writerReady
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'stream_failed' })
    expect(writable.abort).toHaveBeenCalled()
    expect(writable.close).not.toHaveBeenCalled()
  })

  test('treats Content-Disposition as an untrusted filename hint', () => {
    expect(
      responseFilename(
        new Response(null, { headers: { 'Content-Disposition': 'attachment; filename="../x"' } }),
        'safe.jsonl',
      ),
    ).toBe('safe.jsonl')
    expect(
      responseFilename(
        new Response(null, { headers: { 'Content-Disposition': 'attachment; filename="CON"' } }),
        'safe.jsonl',
      ),
    ).toBe('safe.jsonl')
    expect(() => assertContentType(new Response(), plan.media_type)).toThrow(ExportDownloadError)
  })
})
