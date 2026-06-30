import { createReadStream } from 'node:fs'
import { basename, extname } from 'node:path'
import { createInterface } from 'node:readline'
import { type Kind, parseJsonValue, type Sample } from '@databench/schema'
import { isRecord } from './detect-kind.js'
import { recordToSample } from './record-to-sample.js'

export interface ReadJsonlOptions {
  readonly kind?: Kind | null
  readonly source?: string | null
}

export async function* readJsonl(
  path: string,
  options: ReadJsonlOptions = {},
): AsyncIterableIterator<Sample> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  let lineNumber = 0

  try {
    for await (const rawLine of lines) {
      lineNumber += 1

      const line = rawLine.trim()
      if (!line) {
        continue
      }

      let parsed: unknown
      try {
        parsed = parseJsonValue(line)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${path}:${lineNumber}: invalid JSON: ${message}`)
      }

      if (!isRecord(parsed)) {
        throw new Error(
          "could not detect sample kind; expected one of 'messages', 'chosen'/'rejected', or 'rollouts' in the record",
        )
      }

      const source = options.source || pathStem(path)
      yield recordToSample(
        parsed,
        options.kind === undefined ? { source } : { kind: options.kind, source },
      )
    }
  } finally {
    lines.close()
  }
}

function pathStem(path: string): string {
  const name = basename(path)
  const extension = extname(name)
  return extension ? name.slice(0, -extension.length) : name
}
