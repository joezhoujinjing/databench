import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createOpenApiDocument } from '@databench/api'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const outputPath = resolve(repoRoot, 'openapi.json')

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item))
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }

  return value
}

export function renderOpenApi(): string {
  return `${JSON.stringify(sortJson(createOpenApiDocument()), null, 2)}\n`
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const rendered = renderOpenApi()

  if (args.includes('--check')) {
    const current = await readFile(outputPath, 'utf8').catch(() => null)

    if (current !== rendered) {
      console.error(
        'openapi.json is out of date. Run pnpm --filter @databench/openapi-export build && node tooling/openapi-export/dist/index.js',
      )
      process.exitCode = 1
    }

    return
  }

  await writeFile(outputPath, rendered)
}

function isEntrypoint(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
