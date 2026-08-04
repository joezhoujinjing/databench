import { pathToFileURL } from 'node:url'
import {
  loadModelCredentialsV1,
  writeModelCredentialProjectionsAtomicV1,
} from './model-credentials/index.js'

interface ProjectionArguments {
  readonly authority: string
  readonly apiOutput: string
  readonly evalscopeOutput: string
}

export function projectModelCredentialsMainV1(argv: readonly string[]): number {
  const options = parseProjectionArguments(argv)
  const authority = loadModelCredentialsV1(options.authority)
  const generation = writeModelCredentialProjectionsAtomicV1(authority, {
    apiHealth: options.apiOutput,
    evalscope: options.evalscopeOutput,
  })
  process.stdout.write(`Model credential projections prepared for generation ${generation}\n`)
  return generation
}

function parseProjectionArguments(argv: readonly string[]): ProjectionArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (
      name === undefined ||
      value === undefined ||
      !['--authority', '--api-output', '--evalscope-output'].includes(name) ||
      values.has(name)
    ) {
      throw new TypeError(projectionUsage())
    }
    values.set(name, value)
  }
  const authority = values.get('--authority')
  const apiOutput = values.get('--api-output')
  const evalscopeOutput = values.get('--evalscope-output')
  if (authority === undefined || apiOutput === undefined || evalscopeOutput === undefined) {
    throw new TypeError(projectionUsage())
  }
  return { authority, apiOutput, evalscopeOutput }
}

function projectionUsage(): string {
  return 'Usage: model-credentials-project --authority <absolute-path> --api-output <absolute-path> --evalscope-output <absolute-path>'
}

function isEntrypoint(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntrypoint()) {
  try {
    projectModelCredentialsMainV1(process.argv.slice(2))
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'credential_projection_failed'
    process.stderr.write(`Model credential projection failed: ${code}\n`)
    process.exitCode = 1
  }
}
