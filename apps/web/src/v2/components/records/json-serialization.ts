export const JSON_PREVIEW_MAX_BYTES = 512 * 1024

export type JsonSerializationResult =
  | { readonly kind: 'preview'; readonly text: string }
  | { readonly blob: Blob; readonly kind: 'download' }
  | { readonly kind: 'error' }

export function serializeJsonForDisplay(
  value: unknown,
  previewMaxBytes = JSON_PREVIEW_MAX_BYTES,
): JsonSerializationResult {
  try {
    const text = JSON.stringify(value, null, 2)
    if (text === undefined) return { kind: 'error' }
    const blob = new Blob([`${text}\n`], { type: 'application/json;charset=utf-8' })
    return blob.size <= previewMaxBytes ? { kind: 'preview', text } : { blob, kind: 'download' }
  } catch {
    return { kind: 'error' }
  }
}
