import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { v2ObjectStoreConfigFromEnv } from '@databench/store'
import { V2Workspace } from '@databench/workspace'
import { RetirementDatabase } from './database.js'
import { createRetirementManifest, createV2Baseline, parseRetirementManifest } from './manifest.js'
import { RetirementObjectService } from './object-store.js'
import {
  type RetirementManifest,
  RetirementManifestSchema,
  type V2AuditResult,
  V2AuditResultSchema,
  type V2Baseline,
} from './types.js'

const DEFAULT_DATABASE_URL =
  'postgresql://databench:databench@localhost:55432/databench?schema=public'
const RETIREMENT_CURSOR_SECRET = 'databench-v1-retirement-audit-only'
const DEFAULT_MAINTENANCE_ROOT = fileURLToPath(
  new URL('../../../.databench-maintenance/v2-audit-root/', import.meta.url),
)

export interface RetirementRuntime {
  readonly database: RetirementDatabase
  readonly objects: RetirementObjectService
  readonly env: NodeJS.ProcessEnv
}

export interface V2AuditFailure {
  readonly dataset_version: string
  readonly error_name: string
  readonly message: string
  readonly reason?: string
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>
}

export class V2AuditGateError extends Error {
  readonly failures: readonly V2AuditFailure[]

  constructor(failures: readonly V2AuditFailure[]) {
    const versions = failures.map((failure) => failure.dataset_version).join(', ')
    super(`v2 safety audit failed for ${failures.length} dataset version(s): ${versions}`)
    this.name = 'V2AuditGateError'
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })))
  }
}

export function createRetirementRuntime(env: NodeJS.ProcessEnv = process.env): RetirementRuntime {
  return {
    database: new RetirementDatabase(env.DATABASE_URL ?? DEFAULT_DATABASE_URL),
    objects: RetirementObjectService.fromEnv(env),
    env,
  }
}

export async function createPreflight(
  runtime: RetirementRuntime,
): Promise<Readonly<RetirementManifest>> {
  const [databasePlan, objectPlan] = await Promise.all([
    runtime.database.scanV1(),
    runtime.objects.scanV1(),
  ])
  const v2Baseline = await collectV2Baseline(runtime)
  return createRetirementManifest({
    database: databasePlan,
    objects: objectPlan,
    v2Baseline,
  })
}

export async function approveDatabase(
  runtime: RetirementRuntime,
  manifest: Readonly<RetirementManifest>,
  confirmedDigest: string,
): Promise<void> {
  await runtime.database.approveV1Retirement(manifest.database, confirmedDigest)
}

export async function deleteObjects(
  runtime: RetirementRuntime,
  manifest: Readonly<RetirementManifest>,
  confirmedDigest: string,
): Promise<number> {
  const currentBaseline = await collectV2Baseline(runtime)
  assertBaselineEqual(manifest.v2_baseline, currentBaseline)
  const deleted = await runtime.objects.deleteV1(manifest.objects, confirmedDigest)
  const afterBaseline = await collectV2Baseline(runtime)
  assertBaselineEqual(manifest.v2_baseline, afterBaseline)
  return deleted
}

export async function verifyRetirement(
  runtime: RetirementRuntime,
  manifest: Readonly<RetirementManifest>,
): Promise<void> {
  await runtime.database.assertV1TablesAbsent()
  const remainingObjects = await runtime.objects.scanV1()
  if (remainingObjects.targets.length > 0) {
    throw new Error(`${remainingObjects.targets.length} recognized v1 object keys still remain`)
  }
  if (remainingObjects.unrecognized_legacy_prefix_objects.length > 0) {
    throw new Error(
      `${remainingObjects.unrecognized_legacy_prefix_objects.length} unrecognized legacy-prefix objects still remain`,
    )
  }
  const currentBaseline = await collectV2Baseline(runtime)
  assertBaselineEqual(manifest.v2_baseline, currentBaseline)
}

export async function collectV2Baseline(runtime: RetirementRuntime): Promise<Readonly<V2Baseline>> {
  const layouts = await runtime.database.registeredLayouts()
  const audits = await auditRegisteredLayouts(runtime.env, layouts)
  const [catalog, objects] = await Promise.all([
    runtime.database.v2CatalogFingerprint(),
    runtime.objects.listV2Objects(),
  ])
  return createV2Baseline({ catalog, objects, audits })
}

export async function writeManifestFile(
  outputPath: string,
  manifest: Readonly<RetirementManifest>,
): Promise<void> {
  RetirementManifestSchema.parse(manifest)
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  const handle = await open(outputPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function readManifestFile(path: string): Promise<RetirementManifest> {
  const handle = await open(path, 'r')
  try {
    const raw = await handle.readFile('utf8')
    return parseRetirementManifest(JSON.parse(raw) as unknown)
  } finally {
    await handle.close()
  }
}

export async function closeRetirementRuntime(runtime: RetirementRuntime): Promise<void> {
  await runtime.database.close()
}

async function auditRegisteredLayouts(
  env: NodeJS.ProcessEnv,
  layouts: readonly { readonly datasetVersion: string; readonly layoutVersion: string }[],
): Promise<readonly V2AuditResult[]> {
  if (layouts.length === 0) return []

  const workspace = await V2Workspace.open({
    root: env.DATABENCH_ROOT ?? DEFAULT_MAINTENANCE_ROOT,
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    storeConfig: v2ObjectStoreConfigFromEnv(env),
    cursorSecret: env.DATABENCH_V2_CURSOR_SECRET ?? RETIREMENT_CURSOR_SECRET,
  })
  try {
    return await auditRegisteredDatasetLayouts(layouts, async (version) =>
      V2AuditResultSchema.parse(await workspace.audit(version)),
    )
  } finally {
    await workspace.close()
  }
}

export async function auditRegisteredDatasetLayouts(
  layouts: readonly { readonly datasetVersion: string; readonly layoutVersion: string }[],
  audit: (datasetVersion: string) => Promise<V2AuditResult>,
): Promise<readonly V2AuditResult[]> {
  const versions = new Set<string>()
  for (const layout of layouts) {
    if (layout.layoutVersion !== 'record-json-v1') {
      throw new Error(`R4 cannot audit an unsupported v2 layout: ${layout.layoutVersion}`)
    }
    versions.add(layout.datasetVersion)
  }

  const audits: V2AuditResult[] = []
  const failures: V2AuditFailure[] = []
  for (const version of [...versions].sort()) {
    try {
      audits.push(await audit(version))
    } catch (error) {
      failures.push(summarizeAuditFailure(version, error))
    }
  }
  if (failures.length > 0) throw new V2AuditGateError(failures)
  return audits
}

function assertBaselineEqual(expected: Readonly<V2Baseline>, current: Readonly<V2Baseline>): void {
  if (current.digest !== expected.digest) {
    throw new Error(
      `v2 safety baseline changed: expected ${expected.digest}, current ${current.digest}`,
    )
  }
}

function summarizeAuditFailure(datasetVersion: string, error: unknown): V2AuditFailure {
  const errorRecord = isRecord(error) ? error : undefined
  const reason =
    errorRecord && typeof errorRecord.reason === 'string' ? errorRecord.reason : undefined
  const detail = errorRecord ? scalarDetail(errorRecord.detail) : undefined
  return {
    dataset_version: datasetVersion,
    error_name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
  }
}

function scalarDetail(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean | null] =>
      entry[1] === null ||
      typeof entry[1] === 'string' ||
      typeof entry[1] === 'number' ||
      typeof entry[1] === 'boolean',
  )
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
