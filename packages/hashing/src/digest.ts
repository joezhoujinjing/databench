import { TextEncoder } from 'node:util'
import { digest } from './blake3.js'
import { canonicalJson } from './canonical-json.js'

const textEncoder = new TextEncoder()

export function hashBytes(data: ArrayBuffer | ArrayBufferView): string {
  return digest(data)
}

export function hashText(text: string): string {
  return hashBytes(textEncoder.encode(text))
}

export function hashObj(value: unknown): string {
  return hashText(canonicalJson(value))
}

export function hashUnordered(hexes: Iterable<string>): string {
  return hashText([...hexes].sort().join('\n'))
}
