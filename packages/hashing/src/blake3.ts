import { createBLAKE3 } from 'hash-wasm'

export const HASH_ALGO = 'blake3'

type BytesLike = ArrayBuffer | ArrayBufferView

const hasher = await createBLAKE3()
const incrementalHasher = await createBLAKE3()
const incrementalInitialState = incrementalHasher.init().save()

function toUint8Array(data: BytesLike): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  return new Uint8Array(data)
}

export function digest(data: BytesLike): string {
  return hasher.init().update(toUint8Array(data)).digest('hex')
}

export interface IncrementalDigest {
  update(chunk: Uint8Array): void
  digestHex(): string
}

/**
 * Creates a synchronous logical hasher backed by an isolated saved BLAKE3
 * state. `hash-wasm` constructs WASM instances asynchronously, so the module
 * owns one eagerly-created backend and swaps complete states synchronously.
 * This keeps interleaved callers isolated without exposing the third-party
 * hasher outside this package.
 */
export function createIncrementalDigest(): IncrementalDigest {
  let state: Uint8Array = incrementalInitialState.slice()
  let finalized = false

  return {
    update(chunk) {
      if (finalized) {
        throw new Error('Cannot update a finalized BLAKE3 hasher')
      }

      incrementalHasher.load(state).update(chunk)
      state = incrementalHasher.save()
    },
    digestHex() {
      if (finalized) {
        throw new Error('Cannot finalize a BLAKE3 hasher more than once')
      }

      finalized = true
      return incrementalHasher.load(state).digest('hex')
    },
  }
}
