import { createBLAKE3 } from 'hash-wasm'

export const HASH_ALGO = 'blake3'

type BytesLike = ArrayBuffer | ArrayBufferView

const hasher = await createBLAKE3()

function toUint8Array(data: BytesLike): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  return new Uint8Array(data)
}

export function digest(data: BytesLike): string {
  return hasher.init().update(toUint8Array(data)).digest('hex')
}
