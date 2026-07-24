import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, open, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { canonicalJsonV2 } from '../packages/hashing/dist/index.js'
import { PostTrainingRecordV2Schema } from '../packages/schema/dist/index.js'

const [inputArgument, outputArgument] = process.argv.slice(2)
if (!inputArgument || !outputArgument) {
  throw new Error('Usage: node scripts/migrate-v2-system-content.mjs <input.jsonl> <output.jsonl>')
}

const inputPath = resolve(inputArgument)
const outputPath = resolve(outputArgument)
if (inputPath === outputPath) throw new Error('Migration output must not overwrite the input file')
if (!(await stat(inputPath)).isFile()) throw new Error('Migration input must be a regular file')

const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`)
const output = await open(temporaryPath, 'wx', 0o600)
let rows = 0

try {
  const lines = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  for await (const line of lines) {
    if (line.trim().length === 0) continue
    rows += 1
    const migrated = migrateRecord(JSON.parse(line), rows)
    await output.write(`${canonicalJsonV2(PostTrainingRecordV2Schema.parse(migrated))}\n`)
  }
  await output.sync()
  await output.close()
  await link(temporaryPath, outputPath)
  await unlink(temporaryPath)
} catch (error) {
  await output.close().catch(() => undefined)
  await rm(temporaryPath, { force: true })
  throw error
}

process.stdout.write(`${JSON.stringify({ input: inputPath, output: outputPath, rows })}\n`)

function migrateRecord(input, lineNumber) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`Line ${lineNumber} must contain a JSON object`)
  }
  if (!Object.hasOwn(input, 'system_instruction')) return input

  const instruction = input.system_instruction
  if (instruction !== null && (typeof instruction !== 'string' || instruction.length === 0)) {
    throw new TypeError(`Line ${lineNumber} system_instruction must be null or non-empty text`)
  }
  if (!Array.isArray(input.contents)) {
    throw new TypeError(`Line ${lineNumber} contents must be an array`)
  }
  if (input.contents[0]?.role === 'system') {
    throw new TypeError(
      `Line ${lineNumber} already has system content and cannot be migrated twice`,
    )
  }

  delete input.system_instruction
  if (instruction !== null) {
    input.contents.unshift({
      role: 'system',
      parts: [
        {
          type: 'text',
          text: instruction,
          thought: false,
          thought_signature: null,
          part_metadata: {},
        },
      ],
      loss_weight: 0,
    })
  }
  return input
}
