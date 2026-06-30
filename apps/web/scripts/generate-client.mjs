import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = resolve(appRoot, '../..')
const openApiPath = resolve(repoRoot, 'openapi.json')
const generatedPath = resolve(appRoot, 'src/api/generated/schema.ts')
const openApiTypescriptBin = resolve(
  appRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'openapi-typescript.cmd' : 'openapi-typescript',
)

async function main(args = process.argv.slice(2)) {
  if (args.includes('--check')) {
    const directory = await mkdtemp(resolve(tmpdir(), 'databench-openapi-client-'))
    const candidatePath = resolve(directory, 'schema.ts')

    try {
      generate(candidatePath)
      const [current, candidate] = await Promise.all([
        readFile(generatedPath, 'utf8').catch(() => null),
        readFile(candidatePath, 'utf8'),
      ])

      if (current !== candidate) {
        console.error(
          'apps/web generated OpenAPI client is out of date. Run pnpm --filter @databench/web gen:client',
        )
        process.exitCode = 1
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    return
  }

  generate(generatedPath)
}

function generate(outputPath) {
  run(openApiTypescriptBin, [openApiPath, '-o', outputPath], appRoot)
  run('pnpm', ['--dir', repoRoot, 'exec', 'biome', 'format', '--write', outputPath], repoRoot)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
