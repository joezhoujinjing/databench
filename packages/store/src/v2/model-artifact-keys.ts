const DIGEST = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function modelArtifactStagingKeyV1(importId: string): string {
  if (!UUID.test(importId)) {
    throw new TypeError('Model Artifact import ID must be a lowercase UUID')
  }
  return `staging/swift-artifact/v1/${importId}/archive.tar.zst`
}

export function modelArtifactObjectKeyV1(archiveDigest: string): string {
  if (!DIGEST.test(archiveDigest)) {
    throw new TypeError('Model Artifact archive digest must be 64 lowercase hexadecimal characters')
  }
  return `objects/v2/model-artifact-v1/${archiveDigest.slice(0, 2)}/${archiveDigest}.tar.zst`
}
