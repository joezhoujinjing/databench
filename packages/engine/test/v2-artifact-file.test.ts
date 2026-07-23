import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashArtifactBytes } from '@databench/hashing'
import { afterEach, describe, expect, test } from 'vitest'
import { hashV2ArtifactFile } from '../src/v2/artifact-file.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('hashV2ArtifactFile', () => {
  test('hashes an empty file and returns frozen metadata', async () => {
    const path = await createTemporaryFile(new Uint8Array())

    const result = await hashV2ArtifactFile(path)

    expect(result).toEqual({
      artifactDigest: hashArtifactBytes(new Uint8Array()),
      artifactSizeBytes: 0,
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('hashes a file across multiple read-stream chunks', async () => {
    const bytes = Buffer.alloc(4 * 64 * 1024 + 17)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251
    }
    const path = await createTemporaryFile(bytes)

    await expect(hashV2ArtifactFile(path)).resolves.toEqual({
      artifactDigest: hashArtifactBytes(bytes),
      artifactSizeBytes: bytes.byteLength,
    })
  })

  test('propagates a recognizable abort error', async () => {
    const path = await createTemporaryFile(Buffer.alloc(8 * 1024 * 1024, 0x61))
    const controller = new AbortController()

    const result = hashV2ArtifactFile(path, controller.signal)
    controller.abort()

    await expect(result).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    })
  })

  test('propagates the original missing-file I/O error', async () => {
    const directory = await createTemporaryDirectory()
    const missingPath = join(directory, 'missing.parquet')

    await expect(hashV2ArtifactFile(missingPath)).rejects.toMatchObject({
      code: 'ENOENT',
      path: missingPath,
      syscall: 'open',
    })
  })

  test('rejects a file that changes while it is being hashed', async () => {
    const path = await createTemporaryFile(Buffer.alloc(16 * 1024 * 1024, 0x61))

    const result = hashV2ArtifactFile(path)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await appendFile(path, Buffer.from('changed'))

    await expect(result).rejects.toMatchObject({
      code: 'integrity_error',
      detail: expect.objectContaining({ reason: 'artifact_file_changed' }),
    })
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'databench-v2-artifact-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createTemporaryFile(bytes: Uint8Array): Promise<string> {
  const directory = await createTemporaryDirectory()
  const path = join(directory, 'artifact.parquet')
  await writeFile(path, bytes)
  return path
}
