export function streamAsyncIterable(
  source: AsyncIterable<Uint8Array>,
  onCancel: (reason: unknown) => void,
  signal?: AbortSignal,
  onClose?: () => void,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  let closed = false
  let closeNotified = false
  let closing: Promise<void> | undefined
  let pulling = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined

  const removeAbortListener = (): void => {
    signal?.removeEventListener('abort', abortStream)
  }

  const notifyClose = (): void => {
    if (closeNotified) return
    closeNotified = true
    onClose?.()
  }

  const closeIterator = (): Promise<void> => {
    if (closing !== undefined) return closing
    closed = true
    removeAbortListener()
    closing = (async () => {
      try {
        await iterator.return?.()
      } finally {
        notifyClose()
      }
    })()
    return closing
  }

  const abortStream = (): void => {
    const reason = signal?.reason ?? new DOMException('Response stream was aborted', 'AbortError')
    try {
      streamController?.error(reason)
    } catch {
      // The consumer may already have cancelled the stream.
    }
    void closeIterator().catch(() => undefined)
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      signal?.addEventListener('abort', abortStream, { once: true })
      if (signal?.aborted) abortStream()
    },
    async pull(controller) {
      if (closed || pulling) return
      pulling = true
      try {
        const next = await iterator.next()
        if (closed) return
        if (next.done) {
          closed = true
          removeAbortListener()
          notifyClose()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        try {
          await closeIterator()
        } catch {
          // The stream failure remains the useful response-side error.
        }
        controller.error(error)
      } finally {
        pulling = false
      }
    },
    async cancel(reason) {
      onCancel(reason)
      await closeIterator()
    },
  })
}

export function contentDispositionAttachment(suggestedFilename: string): string {
  const safe = sanitizeFilename(suggestedFilename)
  const fallback =
    [...safe]
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint >= 0x20 && codePoint <= 0x7e && character !== '"' && character !== '\\'
          ? character
          : '_'
      })
      .join('')
      .replace(/^\.+$/, '_') || 'dataset.ndjson'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(safe)}`
}

function sanitizeFilename(input: string): string {
  const withoutPaths = input.replaceAll('/', '_').replaceAll('\\', '_')
  let safe = ''
  for (const character of withoutPaths) {
    const codePoint = character.codePointAt(0) ?? 0
    safe += codePoint <= 0x1f || codePoint === 0x7f ? '_' : character
  }
  return safe.trim() || 'dataset.ndjson'
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
