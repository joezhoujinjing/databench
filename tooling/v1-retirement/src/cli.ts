import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  approveDatabase,
  closeRetirementRuntime,
  createPreflight,
  createRetirementRuntime,
  deleteObjects,
  readManifestFile,
  V2AuditGateError,
  verifyRetirement,
  writeManifestFile,
} from './retirement.js'

type Command = 'approve-database' | 'delete-objects' | 'preflight' | 'verify'
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }
  const command = requireCommand(args[0])
  const parsed = parseArgs({
    args: args.slice(1),
    options: {
      output: { type: 'string' },
      manifest: { type: 'string' },
      'confirm-digest': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const runtime = createRetirementRuntime()
  try {
    if (command === 'preflight') {
      const output = resolveRepositoryPath(requiredOption(parsed.values.output, '--output'))
      const manifest = await createPreflight(runtime)
      await writeManifestFile(output, manifest)
      printJson({
        status: 'dry_run_complete',
        manifest: output,
        database: {
          total_rows: manifest.database.total_rows,
          digest: manifest.database.digest,
          tables: manifest.database.tables.map((table) => ({
            name: table.name,
            exists: table.exists,
            row_count: table.row_count,
            total_bytes: table.total_bytes,
          })),
        },
        objects: {
          target_count: manifest.objects.target_count,
          target_bytes: manifest.objects.target_bytes,
          digest: manifest.objects.digest,
          protected_v2_object_count: manifest.objects.protected_v2_object_count,
          unrecognized_count: manifest.objects.unrecognized_legacy_prefix_objects.length,
          sample_keys: manifest.objects.targets.slice(0, 10).map((target) => target.key),
        },
        v2_baseline: {
          digest: manifest.v2_baseline.digest,
          catalog_tables: manifest.v2_baseline.catalog.length,
          object_count: manifest.v2_baseline.objects.length,
          audited_datasets: manifest.v2_baseline.audits.length,
        },
        deletion_performed: false,
      })
      return
    }

    const manifestPath = resolveRepositoryPath(requiredOption(parsed.values.manifest, '--manifest'))
    const manifest = await readManifestFile(manifestPath)

    if (command === 'approve-database') {
      const digest = requiredOption(parsed.values['confirm-digest'], '--confirm-digest')
      await approveDatabase(runtime, manifest, digest)
      printJson({
        status: 'database_retirement_approved',
        database_digest: digest,
        total_rows: manifest.database.total_rows,
        deletion_performed: false,
        next: 'run prisma migrate deploy exactly as documented in the R4 runbook',
      })
      return
    }

    if (command === 'delete-objects') {
      const digest = requiredOption(parsed.values['confirm-digest'], '--confirm-digest')
      const deleted = await deleteObjects(runtime, manifest, digest)
      printJson({
        status: 'legacy_objects_deleted',
        objects_digest: digest,
        deleted,
        v2_baseline_digest: manifest.v2_baseline.digest,
      })
      return
    }

    await verifyRetirement(runtime, manifest)
    printJson({
      status: 'retirement_verified',
      v1_tables_absent: true,
      v1_objects_absent: true,
      v2_baseline_digest: manifest.v2_baseline.digest,
    })
  } finally {
    await closeRetirementRuntime(runtime)
  }
}

function requireCommand(value: string | undefined): Command {
  if (
    value === 'preflight' ||
    value === 'approve-database' ||
    value === 'delete-objects' ||
    value === 'verify'
  ) {
    return value
  }
  throw new TypeError('expected command: preflight | approve-database | delete-objects | verify')
}

function requiredOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`)
  }
  return value
}

function resolveRepositoryPath(value: string): string {
  return resolve(REPOSITORY_ROOT, value)
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printHelp(): void {
  process.stdout.write(`databench v1 retirement maintenance

Commands:
  preflight --output <path>
  approve-database --manifest <path> --confirm-digest <64-hex>
  delete-objects --manifest <path> --confirm-digest <64-hex>
  verify --manifest <path>

preflight is read-only. The two destructive phases require the exact digest
printed by preflight and re-scan the target before changing it.
`)
}

function isEntrypoint(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    if (error instanceof V2AuditGateError) {
      process.stderr.write(
        `${JSON.stringify(
          {
            status: 'blocked',
            code: 'v2_audit_failed',
            message: error.message,
            failures: error.failures,
            deletion_performed: false,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      console.error(error)
    }
    process.exitCode = 1
  })
}
