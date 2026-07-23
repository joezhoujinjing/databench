import type { Readable } from 'node:stream'
import {
  type AddRecordsV2Options,
  AddRecordsV2OptionsSchema,
  BadInputError,
  DomainError,
  ResourceLimitError,
} from '@databench/schema'
import createBusboy from 'busboy'

export const DEFAULT_V2_MULTIPART_MAX_REQUEST_BYTES = 1024 * 1024 * 1024
export const DEFAULT_V2_MULTIPART_MAX_FILE_BYTES = 1024 * 1024 * 1024
export const DEFAULT_V2_MULTIPART_MAX_FIELD_BYTES = 1024 * 1024

const ALLOWED_TEXT_FIELDS = new Set(['ref', 'expected_ref_version', 'message'])
const MAX_ACCEPTED_PARTS = 4

type BusboyFileStream = Readable & { truncated?: boolean }

export interface ParseV2IngestMultipartOptions {
  readonly maxRequestBytes?: number
  readonly maxFileBytes?: number
  readonly maxFieldBytes?: number
  readonly signal?: AbortSignal
}

export interface ParsedV2IngestMultipart {
  /**
   * A single-consumer stream of the uploaded canonical JSONL bytes.
   *
   * Consume this concurrently with `options`. A multipart body may place text
   * fields after the file, and the parser intentionally preserves backpressure
   * instead of buffering the complete file while waiting for those fields.
   */
  readonly file: AsyncIterable<Uint8Array>
  /**
   * Resolves only after the complete multipart envelope has been validated.
   * This includes fields that occur after the file part.
   */
  readonly options: Promise<AddRecordsV2Options>
  /**
   * Explicitly terminates the request and both result channels. Early return
   * from the `file` iterator performs the same cleanup automatically.
   */
  readonly cancel: (reason?: unknown) => void
}

interface MultipartLimits {
  readonly maxRequestBytes: number
  readonly maxFileBytes: number
  readonly maxFieldBytes: number
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

/**
 * Parse the v2 canonical-ingest multipart envelope without buffering the
 * request or file. Boundary recognition is delegated to Busboy; this adapter
 * owns Web-stream pumping, limits, cancellation, and the stricter v2 shape.
 */
export function parseV2IngestMultipart(
  request: Request,
  options: ParseV2IngestMultipartOptions = {},
): ParsedV2IngestMultipart {
  const limits = parseLimits(options)
  const signal =
    options.signal === undefined
      ? request.signal
      : AbortSignal.any([request.signal, options.signal])
  const session = new V2MultipartSession(request, limits, signal)

  return {
    file: session.file,
    options: session.options,
    cancel: (reason?: unknown) => {
      session.cancel(reason)
    },
  }
}

class V2MultipartSession {
  readonly #request: Request
  readonly #limits: MultipartLimits
  readonly #signal: AbortSignal
  readonly #fileSource = deferred<BusboyFileStream>()
  readonly #optionsResult = deferred<AddRecordsV2Options>()
  readonly #fields = new Map<string, string>()
  readonly #parser: ReturnType<typeof createBusboy>
  readonly #abortListener: () => void
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  #fileStream: BusboyFileStream | undefined
  #fileSeen = false
  #fileConsumerClaimed = false
  #failure: unknown | undefined
  #settled = false

  constructor(request: Request, limits: MultipartLimits, signal: AbortSignal) {
    this.#request = request
    this.#limits = limits
    this.#signal = signal

    const contentType = request.headers.get('content-type')
    if (contentType === null || !/^\s*multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) {
      throw invalidContentType()
    }

    try {
      this.#parser = createBusboy({
        headers: { 'content-type': contentType },
        defCharset: 'utf8',
        defParamCharset: 'utf8',
        preservePath: false,
        limits: {
          // Busboy marks an exactly-reached fileSize as truncated. Give it one
          // sentinel byte and enforce the inclusive v2 limit in our iterator.
          fileSize: limits.maxFileBytes + 1,
          fieldSize: limits.maxFieldBytes + 1,
          fields: MAX_ACCEPTED_PARTS,
          files: 2,
          parts: MAX_ACCEPTED_PARTS + 1,
          headerPairs: 32,
        },
      })
    } catch {
      throw invalidContentType()
    }

    // A result channel may be observed later (for example, Workspace first
    // consumes `file`). Mark both promises handled without changing what a
    // later await observes.
    void this.#fileSource.promise.catch(() => undefined)
    void this.#optionsResult.promise.catch(() => undefined)

    this.#parser.on('file', (name, stream) => {
      this.#onFile(name, stream)
    })
    this.#parser.on('field', (name, value, info) => {
      this.#onField(name, value, info)
    })
    this.#parser.on('partsLimit', () => {
      this.#fail(new BadInputError('multipart request contains too many parts'))
    })
    this.#parser.on('filesLimit', () => {
      this.#fail(new BadInputError('multipart request contains additional file parts'))
    })
    this.#parser.on('fieldsLimit', () => {
      this.#fail(new BadInputError('multipart request contains too many text fields'))
    })
    this.#parser.on('error', (error) => {
      this.#fail(this.#failure ?? parserError(error))
    })

    this.#abortListener = () => {
      this.#fail(this.#signal.reason ?? abortError('multipart request was aborted'))
    }
    this.#signal.addEventListener('abort', this.#abortListener, { once: true })

    if (this.#signal.aborted) {
      this.#abortListener()
    } else {
      void this.#pump()
    }
  }

  get options(): Promise<AddRecordsV2Options> {
    return this.#optionsResult.promise
  }

  get file(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => this.#iterateFile(),
    }
  }

  cancel(reason: unknown = abortError('multipart request was cancelled')): void {
    this.#fail(reason)
  }

  async *#iterateFile(): AsyncGenerator<Uint8Array, void, undefined> {
    if (this.#fileConsumerClaimed) {
      const error = new BadInputError('multipart file stream can only be consumed once')
      this.#fail(error)
      throw error
    }
    this.#fileConsumerClaimed = true

    let completed = false
    try {
      const stream = await this.#fileSource.promise
      let fileBytes = 0

      for await (const chunk of stream) {
        this.#throwIfFailed()
        this.#signal.throwIfAborted()

        if (!(chunk instanceof Uint8Array)) {
          throw new BadInputError('multipart file stream produced a non-byte chunk')
        }
        if (chunk.byteLength > this.#limits.maxFileBytes - fileBytes) {
          throw fileLimitError(this.#limits.maxFileBytes, nextActual(fileBytes, chunk.byteLength))
        }

        fileBytes += chunk.byteLength
        yield chunk
      }

      this.#throwIfFailed()
      this.#signal.throwIfAborted()
      if (stream.truncated === true) {
        throw fileLimitError(this.#limits.maxFileBytes, this.#limits.maxFileBytes + 1)
      }
      completed = true
    } catch (error) {
      const primary =
        this.#failure ??
        (error instanceof DomainError
          ? error
          : this.#signal.aborted
            ? (this.#signal.reason ?? abortError('multipart request was aborted'))
            : parserError(error))
      this.#fail(primary)
      throw primary
    } finally {
      if (!completed && this.#failure === undefined) {
        this.#fail(abortError('multipart file consumer stopped before completion'))
      }
    }
  }

  #onFile(name: string, stream: BusboyFileStream): void {
    // A permanent listener prevents an unhandled Node stream error if a
    // request fails before the async consumer has attached.
    stream.on('error', () => undefined)

    if (this.#failure !== undefined) {
      stream.destroy(asError(this.#failure))
      return
    }
    if (name !== 'file') {
      stream.destroy()
      this.#fail(new BadInputError(`unknown or additional multipart file field "${name}"`))
      return
    }
    if (this.#fileSeen) {
      stream.destroy()
      this.#fail(new BadInputError('multipart file field "file" must appear exactly once'))
      return
    }

    this.#fileSeen = true
    this.#fileStream = stream
    stream.once('limit', () => {
      this.#fail(fileLimitError(this.#limits.maxFileBytes, this.#limits.maxFileBytes + 1))
    })
    stream.once('close', () => {
      if (this.#fileStream === stream) {
        this.#fileStream = undefined
      }
    })
    this.#fileSource.resolve(stream)
  }

  #onField(
    name: string,
    value: string,
    info: { readonly nameTruncated: boolean; readonly valueTruncated: boolean },
  ): void {
    if (this.#failure !== undefined) return

    if (info.nameTruncated || info.valueTruncated) {
      this.#fail(
        new ResourceLimitError('multipart text field exceeds its byte limit', {
          resource: 'multipart_field_bytes',
          field: name,
          limit: this.#limits.maxFieldBytes,
          actual: this.#limits.maxFieldBytes + 1,
        }),
      )
      return
    }
    if (!ALLOWED_TEXT_FIELDS.has(name)) {
      this.#fail(new BadInputError(`unknown multipart text field "${name}"`))
      return
    }
    if (this.#fields.has(name)) {
      this.#fail(new BadInputError(`multipart text field "${name}" must not be repeated`))
      return
    }
    if (value === '' || value === 'null') {
      this.#fail(
        new BadInputError(
          `multipart text field "${name}" must be absent instead of empty or literal null`,
        ),
      )
      return
    }
    const valueBytes = new TextEncoder().encode(value).byteLength
    if (valueBytes > this.#limits.maxFieldBytes) {
      this.#fail(
        new ResourceLimitError('multipart text field exceeds its byte limit', {
          resource: 'multipart_field_bytes',
          field: name,
          limit: this.#limits.maxFieldBytes,
          actual: valueBytes,
        }),
      )
      return
    }

    this.#fields.set(name, value)
  }

  async #pump(): Promise<void> {
    try {
      const body = this.#request.body
      if (body === null) {
        throw new BadInputError('multipart request body is required')
      }

      this.#reader = body.getReader()
      let requestBytes = 0

      while (true) {
        this.#throwIfFailed()
        this.#signal.throwIfAborted()
        const { done, value } = await this.#reader.read()
        if (done) break
        this.#throwIfFailed()
        this.#signal.throwIfAborted()

        if (!(value instanceof Uint8Array)) {
          throw new BadInputError('multipart request body produced a non-byte chunk')
        }
        if (value.byteLength > this.#limits.maxRequestBytes - requestBytes) {
          throw new ResourceLimitError('multipart request exceeds its byte limit', {
            resource: 'request_bytes',
            limit: this.#limits.maxRequestBytes,
            actual: nextActual(requestBytes, value.byteLength),
          })
        }
        requestBytes += value.byteLength
        if (value.byteLength > 0) {
          await writeParser(this.#parser, value)
        }
      }

      await endParser(this.#parser)
      this.#throwIfFailed()
      this.#signal.throwIfAborted()

      if (!this.#fileSeen) {
        throw new BadInputError('multipart file field "file" is required exactly once')
      }

      const parsedOptions = AddRecordsV2OptionsSchema.parse({
        ref: this.#fields.get('ref') ?? null,
        expected_ref_version: this.#fields.get('expected_ref_version') ?? null,
        message: this.#fields.get('message') ?? null,
      })

      this.#settled = true
      this.#optionsResult.resolve(parsedOptions)
    } catch (error) {
      this.#fail(this.#failure ?? error)
    } finally {
      this.#signal.removeEventListener('abort', this.#abortListener)
      try {
        this.#reader?.releaseLock()
      } catch {
        // The reader is already being cancelled by the primary failure.
      }
    }
  }

  #throwIfFailed(): void {
    if (this.#failure !== undefined) {
      throw this.#failure
    }
  }

  #fail(error: unknown): void {
    if (this.#settled || this.#failure !== undefined) return
    this.#failure = error
    this.#signal.removeEventListener('abort', this.#abortListener)

    this.#fileSource.reject(error)
    this.#optionsResult.reject(error)

    const stream = this.#fileStream
    this.#fileStream = undefined
    if (stream !== undefined && !stream.destroyed) {
      stream.destroy(asError(error))
    }
    if (!this.#parser.destroyed) {
      this.#parser.destroy(asError(error))
    }
    if (this.#reader !== undefined) {
      void this.#reader.cancel(error).catch(() => undefined)
    } else {
      void this.#request.body?.cancel(error).catch(() => undefined)
    }
  }
}

function parseLimits(options: ParseV2IngestMultipartOptions): MultipartLimits {
  const maxRequestBytes = validateLimit(
    options.maxRequestBytes ?? DEFAULT_V2_MULTIPART_MAX_REQUEST_BYTES,
    'maxRequestBytes',
  )
  const maxFileBytes = validateLimit(
    options.maxFileBytes ?? DEFAULT_V2_MULTIPART_MAX_FILE_BYTES,
    'maxFileBytes',
  )
  const maxFieldBytes = validateLimit(
    options.maxFieldBytes ?? DEFAULT_V2_MULTIPART_MAX_FIELD_BYTES,
    'maxFieldBytes',
  )

  if (maxFileBytes === Number.MAX_SAFE_INTEGER || maxFieldBytes === Number.MAX_SAFE_INTEGER) {
    throw new TypeError('multipart limits must leave room for one sentinel byte')
  }

  return { maxRequestBytes, maxFileBytes, maxFieldBytes }
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`multipart ${name} must be a non-negative safe integer`)
  }
  return value
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function writeParser(parser: ReturnType<typeof createBusboy>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    parser.write(chunk, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

function endParser(parser: ReturnType<typeof createBusboy>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      reject(error)
    }
    parser.once('error', onError)
    parser.end(() => {
      parser.off('error', onError)
      resolve()
    })
  })
}

function invalidContentType(): BadInputError {
  return new BadInputError(
    'content-type must be multipart/form-data with a valid boundary parameter',
  )
}

function parserError(error: unknown): BadInputError {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('Unexpected end')) {
    return new BadInputError('multipart request body is truncated')
  }
  if (message.includes('Malformed part header')) {
    return new BadInputError('multipart part header is malformed')
  }
  return new BadInputError('multipart request body is malformed')
}

function fileLimitError(maxBytes: number, actual: number | string): ResourceLimitError {
  return new ResourceLimitError('multipart file exceeds its byte limit', {
    resource: 'file_bytes',
    field: 'file',
    limit: maxBytes,
    actual,
  })
}

function nextActual(current: number, increment: number): number | string {
  return current <= Number.MAX_SAFE_INTEGER - increment
    ? current + increment
    : (BigInt(current) + BigInt(increment)).toString()
}

function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error('multipart request failed')
  Object.defineProperty(error, 'cause', {
    configurable: true,
    value: reason,
    writable: true,
  })
  return error
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}
