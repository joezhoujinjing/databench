import { describe, expect, test, vi } from 'vitest'
import type { ApiV2Workspace } from '../src/context.js'
import { createTestApp } from './test-app.js'

const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333'
const ARCHIVE = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])

function request(path: string): Request {
  return new Request(`http://localhost${path}`)
}

describe('Model Artifact HTTP contract', () => {
  test('routes the download action before the Artifact detail wildcard and streams bytes', async () => {
    const getModelArtifact = vi.fn(async () => {
      throw new Error('detail route must not handle an action target')
    })
    const downloadModelArtifact = vi.fn(async () => ({
      artifact: {
        archive_size_bytes: ARCHIVE.byteLength,
        display_name: 'customer service adapter',
      },
      bytes: (async function* () {
        yield ARCHIVE
      })(),
    }))
    const workspace = {
      downloadModelArtifact,
      getModelArtifact,
    } as unknown as ApiV2Workspace

    const response = await createTestApp({ v2Workspace: workspace }).fetch(
      request(`/v2/model-artifacts/${ARTIFACT_ID}:download`),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zstd')
    expect(response.headers.get('Content-Length')).toBe(String(ARCHIVE.byteLength))
    expect(response.headers.get('Content-Disposition')).toContain(
      'customer service adapter.tar.zst',
    )
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ARCHIVE)
    expect(downloadModelArtifact).toHaveBeenCalledWith(
      ARTIFACT_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(getModelArtifact).not.toHaveBeenCalled()
  })
})
