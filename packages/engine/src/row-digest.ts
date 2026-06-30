import { hashText } from '@databench/hashing'

export function rowDigest(
  payloadJson: string,
  source: string | null | undefined,
  metaJson: string,
  signalsJson: string,
): string {
  return hashText([payloadJson, source || '', metaJson, signalsJson].join('\u0000'))
}
