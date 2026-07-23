import { createIncrementalDigest, digest } from '../blake3.js'

export interface ArtifactHasher {
  update(chunk: Uint8Array): void
  digestHex(): string
}

export function hashArtifactBytes(bytes: Uint8Array): string {
  return digest(bytes)
}

export function createArtifactHasher(): ArtifactHasher {
  return createIncrementalDigest()
}
