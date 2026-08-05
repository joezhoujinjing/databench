import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKSPACE_ROOTS = ['apps', 'packages', 'tooling']
const SOURCE_ROOTS = [...WORKSPACE_ROOTS, 'scripts', 'workers']
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set(['.git', '.turbo', '.venv', 'coverage', 'dist', 'node_modules'])

const ALLOWED_INTERNAL_DEPENDENCIES = new Map([
  ['@databench/hashing', new Set()],
  ['@databench/schema', new Set(['@databench/hashing'])],
  ['@databench/engine', new Set(['@databench/hashing', '@databench/schema'])],
  ['@databench/io', new Set(['@databench/schema'])],
  ['@databench/catalog', new Set()],
  ['@databench/ops', new Set(['@databench/engine', '@databench/schema'])],
  ['@databench/store', new Set(['@databench/engine', '@databench/hashing', '@databench/schema'])],
  [
    '@databench/workspace',
    new Set([
      '@databench/catalog',
      '@databench/engine',
      '@databench/hashing',
      '@databench/io',
      '@databench/ops',
      '@databench/schema',
      '@databench/store',
    ]),
  ],
  ['@databench/api', new Set(['@databench/schema', '@databench/workspace'])],
  ['@databench/cli', new Set(['@databench/schema', '@databench/workspace'])],
  ['@databench/web', new Set()],
  ['@databench/openapi-export', new Set(['@databench/api'])],
  [
    '@databench/v1-retirement',
    new Set(['@databench/hashing', '@databench/store', '@databench/workspace']),
  ],
])

const APPLICATION_PACKAGES = new Set(['@databench/api', '@databench/cli'])
const APPLICATION_DATA_BOUNDARY_IMPORTS = new Set([
  '@aws-sdk/client-s3',
  '@prisma/adapter-pg',
  '@prisma/client',
  'ali-oss',
  'pg',
  'prisma',
])

const ALLOWED_PRISMA_JSON_FIELDS = new Set([
  'V2DatasetLayout.columns',
  'V2EvaluationRun.archiveError',
  'V2EvaluationRun.converterOptions',
  'V2EvaluationRun.error',
  'V2EvaluationRun.metrics',
  'V2EvaluationRun.providerReportIds',
  'V2EvaluationRun.scoringConfig',
  'V2Model.tags',
  'V2ModelArtifact.manifest',
  'V2ModelArtifactImport.failure',
  'V2ModelArtifactImport.manifest',
  'V2ModelDeployment.declaredCapabilities',
  'V2ModelRegistrationClaim.normalizedRequest',
  'V2Run.params',
  'V2SwiftStudioSession.failure',
  'V2SwiftStudioSession.normalizedOptions',
  'V2TransformJob.error',
  'V2TransformJob.params',
  'V2TransformJob.progress',
])

const ALLOWED_SQL_JSON_COLUMNS = new Set([
  'archive_error_json',
  'columns_json',
  'converter_options_json',
  'declared_capabilities_json',
  'error_json',
  'failure_json',
  'inputs_json',
  'kinds_json',
  'manifest_json',
  'metrics_json',
  'normalized_options_json',
  'normalized_request_json',
  'params_json',
  'progress_json',
  'provider_report_ids_json',
  'scoring_config_json',
  'tags_json',
])

const ALLOWED_RECORD_MODELS = new Map([
  ['V2RecordRevisionLocation', new Set(['datasetVersion', 'recordDigest', 'recordId'])],
  [
    'V2RecordParentEdge',
    new Set([
      'childRecordDigest',
      'childRecordId',
      'parentRecordDigest',
      'parentRecordId',
      'position',
    ]),
  ],
])

const FORBIDDEN_PAYLOAD_FIELD_NAMES = new Set([
  'candidate',
  'candidates',
  'completion',
  'completions',
  'content',
  'contents',
  'messages',
  'payload',
  'prompt',
  'prompts',
  'recordjson',
  'recordpayload',
  'response',
  'responses',
  'samplejson',
  'samplepayload',
])

function normalizeFieldName(value) {
  return value.replaceAll('_', '').toLowerCase()
}

function fail(errors, message) {
  errors.push(message)
}

async function pathExists(target) {
  try {
    await readFile(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
      return false
    }
    throw error
  }
}

async function collectFiles(directory, predicate, output = []) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return output
    }
    throw error
  }

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(target, predicate, output)
    } else if (entry.isFile() && predicate(target)) {
      output.push(target)
    }
  }
  return output
}

async function readWorkspacePackages(root) {
  const packages = []
  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const directory = path.join(root, workspaceRoot)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const packageRoot = path.join(directory, entry.name)
      const manifestPath = path.join(packageRoot, 'package.json')
      if (!(await pathExists(manifestPath))) {
        continue
      }
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      packages.push({ manifest, manifestPath, packageRoot })
    }
  }
  return packages
}

function internalPackageName(specifier) {
  return specifier.match(/^(@databench\/[^/]+)(?:\/.*)?$/)?.[1]
}

function codeSpecifiers(source) {
  const specifiers = []
  const pattern = /(?:from\s*|import\s*\(|require\s*\(|import\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1])
  }
  return specifiers
}

function isApplicationDataBoundaryImport(specifier) {
  return [...APPLICATION_DATA_BOUNDARY_IMPORTS].some(
    (blocked) => specifier === blocked || specifier.startsWith(`${blocked}/`),
  )
}

function checkPackageDag(workspaces, errors) {
  for (const { manifest, manifestPath } of workspaces) {
    const allowed = ALLOWED_INTERNAL_DEPENDENCIES.get(manifest.name)
    const relativeManifest = manifestPath
    if (!allowed) {
      fail(errors, `${relativeManifest}: unregistered workspace package ${manifest.name}`)
      continue
    }

    for (const dependencyGroup of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [dependency, version] of Object.entries(manifest[dependencyGroup] ?? {})) {
        if (!dependency.startsWith('@databench/')) {
          continue
        }
        if (!allowed.has(dependency)) {
          fail(errors, `${relativeManifest}: ${manifest.name} may not depend on ${dependency}`)
        }
        if (version !== 'workspace:*') {
          fail(
            errors,
            `${relativeManifest}: internal dependency ${dependency} must use workspace:*`,
          )
        }
      }
    }
  }
}

async function checkSourceImports(root, workspaces, errors) {
  const workspaceByRoot = [...workspaces].sort(
    (left, right) => right.packageRoot.length - left.packageRoot.length,
  )
  const files = []
  for (const sourceRoot of SOURCE_ROOTS) {
    await collectFiles(
      path.join(root, sourceRoot),
      (file) => SOURCE_EXTENSIONS.has(path.extname(file)),
      files,
    )
  }

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const relativeFile = path.relative(root, file)
    const workspace = workspaceByRoot.find(
      ({ packageRoot }) => file === packageRoot || file.startsWith(`${packageRoot}${path.sep}`),
    )
    const packageName = workspace?.manifest.name
    const allowed = ALLOWED_INTERNAL_DEPENDENCIES.get(packageName)

    for (const specifier of codeSpecifiers(source)) {
      const internalPackage = internalPackageName(specifier)
      if (internalPackage && specifier !== internalPackage) {
        fail(errors, `${relativeFile}: deep import is forbidden: ${specifier}`)
      }
      if (internalPackage && packageName && !allowed?.has(internalPackage)) {
        fail(errors, `${relativeFile}: ${packageName} may not import ${internalPackage}`)
      }
      if (APPLICATION_PACKAGES.has(packageName) && isApplicationDataBoundaryImport(specifier)) {
        fail(
          errors,
          `${relativeFile}: ${packageName} must access data through Workspace, not ${specifier}`,
        )
      }
    }
  }
  return files.length
}

function parsePrismaModels(schema) {
  const models = []
  let current
  for (const [index, line] of schema.split('\n').entries()) {
    const modelMatch = line.match(/^model\s+(\w+)\s*\{$/)
    if (modelMatch) {
      current = { fields: [], line: index + 1, name: modelMatch[1] }
      models.push(current)
      continue
    }
    if (!current) {
      continue
    }
    if (line === '}') {
      current = undefined
      continue
    }
    const fieldMatch = line.match(/^\s{2}(\w+)\s+([A-Za-z0-9_]+(?:\[\])?\??)(?:\s|$)/)
    if (fieldMatch) {
      current.fields.push({ line: index + 1, name: fieldMatch[1], type: fieldMatch[2] })
    }
  }
  return models
}

function checkPrismaSchema(schema, errors) {
  const models = parsePrismaModels(schema)
  for (const model of models) {
    if (/(?:Record|Sample)/.test(model.name) && !ALLOWED_RECORD_MODELS.has(model.name)) {
      fail(
        errors,
        `prisma/schema.prisma:${model.line}: record/sample model is not allowlisted: ${model.name}`,
      )
    }

    for (const field of model.fields) {
      const fieldKey = `${model.name}.${field.name}`
      if (/^Json\??$/.test(field.type) && !ALLOWED_PRISMA_JSON_FIELDS.has(fieldKey)) {
        fail(
          errors,
          `prisma/schema.prisma:${field.line}: unreviewed PostgreSQL JSON field ${fieldKey}`,
        )
      }
      if (FORBIDDEN_PAYLOAD_FIELD_NAMES.has(normalizeFieldName(field.name))) {
        fail(
          errors,
          `prisma/schema.prisma:${field.line}: payload-bearing field is forbidden: ${fieldKey}`,
        )
      }

      const allowedScalars = ALLOWED_RECORD_MODELS.get(model.name)
      const isRelation = /^V2\w+(?:\[\])?\??$/.test(field.type)
      if (allowedScalars && !isRelation && !allowedScalars.has(field.name)) {
        fail(
          errors,
          `prisma/schema.prisma:${field.line}: ${fieldKey} exceeds the record locator-only boundary`,
        )
      }
    }
  }
  return models.length
}

function checkMigrationSql(relativePath, sql, errors) {
  let currentTable
  for (const [index, line] of sql.split('\n').entries()) {
    const createTable = line.match(/^CREATE TABLE(?: IF NOT EXISTS)?\s+"([^"]+)"\s*\($/i)
    if (createTable) {
      currentTable = createTable[1]
      continue
    }
    if (currentTable && /^\);\s*$/.test(line)) {
      currentTable = undefined
      continue
    }

    const addColumn = line.match(/\bADD COLUMN\s+"([^"]+)"\s+([A-Z0-9()[\], ]+)/i)
    const createColumn = currentTable
      ? line.match(/^\s*"([^"]+)"\s+([A-Z][A-Z0-9]*(?:\([^)]*\))?)/i)
      : undefined
    const column = addColumn ?? createColumn
    if (!column) {
      continue
    }

    const [, name, type] = column
    const location = `${relativePath}:${index + 1}`
    if (FORBIDDEN_PAYLOAD_FIELD_NAMES.has(normalizeFieldName(name))) {
      fail(errors, `${location}: payload-bearing PostgreSQL column is forbidden: ${name}`)
    }
    if (/\bJSONB?\b/i.test(type) && !ALLOWED_SQL_JSON_COLUMNS.has(name)) {
      fail(errors, `${location}: unreviewed PostgreSQL JSON column ${name}`)
    }
  }
}

async function checkPostgresBoundary(root, errors) {
  const schemaPath = path.join(root, 'prisma/schema.prisma')
  if (!(await pathExists(schemaPath))) {
    fail(errors, 'prisma/schema.prisma is missing')
    return { migrations: 0, models: 0 }
  }

  const models = checkPrismaSchema(await readFile(schemaPath, 'utf8'), errors)
  const migrationRoot = path.join(root, 'prisma/migrations')
  const migrations = await collectFiles(
    migrationRoot,
    (file) => path.basename(file) === 'migration.sql',
  )
  for (const migration of migrations) {
    checkMigrationSql(path.relative(root, migration), await readFile(migration, 'utf8'), errors)
  }
  return { migrations: migrations.length, models }
}

export async function checkArchitecture(root) {
  const resolvedRoot = path.resolve(root)
  const errors = []
  const workspaces = await readWorkspacePackages(resolvedRoot)
  checkPackageDag(workspaces, errors)
  const sourceFiles = await checkSourceImports(resolvedRoot, workspaces, errors)
  const postgres = await checkPostgresBoundary(resolvedRoot, errors)
  return {
    errors,
    migrations: postgres.migrations,
    models: postgres.models,
    sourceFiles,
    workspaces: workspaces.length,
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = await checkArchitecture(root)
  if (result.errors.length > 0) {
    throw new Error(`architecture check failed:\n- ${result.errors.join('\n- ')}`)
  }
  console.log(
    `architecture ok: ${result.workspaces} workspaces, ${result.sourceFiles} source files, ` +
      `${result.models} Prisma models, ${result.migrations} migrations`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
