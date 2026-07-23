import { type BigIntStats, constants } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { createArtifactHasher } from '@databench/hashing'
import { IntegrityError, ResourceLimitError } from '@databench/schema'

export interface V2ArtifactFileDigest {
  readonly artifactDigest: string
  readonly artifactSizeBytes: number
}

export async function hashV2ArtifactFile(
  path: string,
  signal?: AbortSignal,
): Promise<Readonly<V2ArtifactFileDigest>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await hashV2ArtifactFileHandle(handle, signal)
  } finally {
    await handle.close()
  }
}

export async function hashV2ArtifactFileHandle(
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<Readonly<V2ArtifactFileDigest>> {
  throwIfAborted(signal)
  const before = await handle.stat({ bigint: true })
  if (!before.isFile()) {
    throw new TypeError('V2 artifact must be a regular file')
  }
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ResourceLimitError('Artifact file size exceeds the safe integer range', {
      resource: 'artifact_size_bytes',
      limit: Number.MAX_SAFE_INTEGER,
      actual: before.size.toString(),
    })
  }

  const hasher = createArtifactHasher()
  let artifactSizeBytes = 0
  const buffer = Buffer.allocUnsafe(64 * 1024)
  while (artifactSizeBytes < Number(before.size)) {
    throwIfAborted(signal)
    const remaining = Number(before.size) - artifactSizeBytes
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, remaining),
      artifactSizeBytes,
    )
    if (bytesRead === 0) {
      throw artifactChanged()
    }
    artifactSizeBytes = checkedAddArtifactSize(artifactSizeBytes, bytesRead)
    hasher.update(buffer.subarray(0, bytesRead))
  }

  throwIfAborted(signal)
  const after = await handle.stat({ bigint: true })
  if (!sameFileSnapshot(before, after)) throw artifactChanged()

  return Object.freeze({
    artifactDigest: hasher.digestHex(),
    artifactSizeBytes,
  })
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function artifactChanged(): IntegrityError {
  return new IntegrityError('Artifact file changed while its digest was being computed', {
    reason: 'artifact_file_changed',
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('The operation was aborted', { cause: signal.reason }) as Error & {
    code: string
  }
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  throw error
}

function checkedAddArtifactSize(current: number, chunkSize: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 0 ||
    chunkSize > Number.MAX_SAFE_INTEGER - current
  ) {
    const actual =
      Number.isSafeInteger(current) && Number.isSafeInteger(chunkSize)
        ? (BigInt(current) + BigInt(chunkSize)).toString()
        : 'outside-safe-integer-range'
    throw new ResourceLimitError('Artifact file size exceeds the safe integer range', {
      resource: 'artifact_size_bytes',
      limit: Number.MAX_SAFE_INTEGER,
      actual,
    })
  }

  return current + chunkSize
}
