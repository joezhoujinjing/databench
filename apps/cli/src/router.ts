import { parseArgs } from 'node:util'
import { BadInputError } from '@databench/schema'
import { datasetCommands } from './commands/dataset.js'
import { lineageCommands } from './commands/lineage.js'
import { metaCommands } from './commands/meta.js'
import { recipeCommands } from './commands/recipe.js'
import { refCommands } from './commands/ref.js'
import { transformCommands } from './commands/transform.js'
import { vocabCommands } from './commands/vocab.js'
import type { GlobalFlags } from './config.js'
import { emitResult } from './output.js'
import { type CommandGroup, STREAMED, type Values } from './types.js'

const COMMANDS: Record<string, CommandGroup> = {
  dataset: datasetCommands,
  transform: transformCommands,
  recipe: recipeCommands,
  ref: refCommands,
  lineage: lineageCommands,
  vocab: vocabCommands,
  meta: metaCommands,
}

const GLOBAL_STRING = new Set(['--database-url'])
const GLOBAL_BOOL = new Set(['--compact'])
const HELP_TOKENS = new Set(['help', '--help', '-h'])

// Pull recognized global flags from anywhere in argv (they can precede or follow
// the noun, since global names never collide with command flag names); remaining
// tokens keep their order and become `rest` for the per-command parser. Tokens
// after a `--` terminator are passed through untouched.
export function parseGlobal(argv: readonly string[]): { flags: GlobalFlags; rest: string[] } {
  let databaseUrl: string | undefined
  let compact = false
  const rest: string[] = []
  let index = 0
  let passthrough = false

  while (index < argv.length) {
    const token = argv[index]
    if (token === undefined) {
      break
    }
    if (passthrough) {
      rest.push(token)
      index += 1
      continue
    }
    if (token === '--') {
      rest.push(token)
      passthrough = true
      index += 1
      continue
    }
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=')
      const key = token.slice(0, eq)
      const value = token.slice(eq + 1)
      if (key === '--database-url') {
        databaseUrl = value
      } else if (GLOBAL_BOOL.has(key)) {
        // Boolean globals don't take a value (mirrors parseArgs semantics).
        throw new BadInputError(`${key} does not take a value`)
      } else {
        rest.push(token)
      }
      index += 1
      continue
    }
    if (GLOBAL_STRING.has(token)) {
      const value = argv[index + 1]
      // Guard against consuming the next flag as this one's value.
      if (value === undefined || value.startsWith('--')) {
        throw new BadInputError(`${token} requires a value`)
      }
      databaseUrl = value
      index += 2
      continue
    }
    if (GLOBAL_BOOL.has(token)) {
      compact = true
      index += 1
      continue
    }
    rest.push(token)
    index += 1
  }

  const flags: GlobalFlags = {
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    compact,
  }
  return { flags, rest }
}

export async function dispatch(rest: readonly string[], flags: GlobalFlags): Promise<void> {
  const head = rest[0]
  if (head === undefined || HELP_TOKENS.has(head)) {
    emitHelp(rest[1], flags)
    return
  }

  const group = COMMANDS[head]
  if (group === undefined) {
    throw new BadInputError(
      `unknown command: ${head}. Available: ${Object.keys(COMMANDS).join(', ')}. Run 'databench help'.`,
    )
  }

  const maybeVerb = rest[1]
  // Support the conventional `<cmd> --help` / `<cmd> -h` for scoped help.
  if (maybeVerb !== undefined && HELP_TOKENS.has(maybeVerb)) {
    emitHelp(head, flags)
    return
  }
  let verbName: string
  let verbArgv: readonly string[]
  if (maybeVerb !== undefined && Object.hasOwn(group.verbs, maybeVerb)) {
    verbName = maybeVerb
    verbArgv = rest.slice(2)
  } else if (group.defaultVerb !== undefined) {
    verbName = group.defaultVerb
    verbArgv = rest.slice(1)
  } else {
    throw new BadInputError(
      `unknown subcommand for '${head}': ${maybeVerb ?? '(none)'}. Available: ${Object.keys(group.verbs).join(', ')}.`,
    )
  }

  const verb = group.verbs[verbName]
  if (verb === undefined) {
    throw new BadInputError(`unknown subcommand for '${head}': ${verbName}`)
  }

  let parsed: { values: Record<string, unknown>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: [...verbArgv],
      options: verb.options,
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    // parseArgs throws on unknown/malformed flags — surface as a usage error.
    throw new BadInputError(
      error instanceof Error ? error.message : `invalid arguments for '${head} ${verbName}'`,
    )
  }

  const result = await verb.run({
    positionals: parsed.positionals,
    values: parsed.values as unknown as Values,
    flags,
  })

  // STREAMED means the handler already wrote its own output (e.g. NDJSON export).
  if (result !== STREAMED) {
    emitResult(result, flags.compact)
  }
}

// Machine-readable command catalog — always JSON, so an agent can discover the
// full surface programmatically and treat it as an executable contract: each
// verb reports its positionals, its flags (type / short alias / multiple), and
// its output kind ('json' or the raw 'ndjson' stream exception).
function commandCatalog() {
  return {
    commands: Object.entries(COMMANDS).map(([name, group]) => ({
      name,
      summary: group.summary,
      ...(group.defaultVerb !== undefined ? { default_verb: group.defaultVerb } : {}),
      verbs: Object.entries(group.verbs).map(([verb, definition]) => ({
        name: verb,
        summary: definition.summary,
        output: definition.output ?? 'json',
        positionals: definition.positionals ?? [],
        options: Object.entries(definition.options).map(([option, spec]) => ({
          name: option,
          type: spec.type,
          ...(spec.short !== undefined ? { short: spec.short } : {}),
          ...(spec.multiple === true ? { multiple: true } : {}),
        })),
      })),
    })),
  }
}

function emitHelp(topic: string | undefined, flags: GlobalFlags): void {
  if (topic !== undefined && !Object.hasOwn(COMMANDS, topic)) {
    throw new BadInputError(
      `unknown command: ${topic}. Available: ${Object.keys(COMMANDS).join(', ')}.`,
    )
  }
  const catalog = commandCatalog()
  const payload =
    topic !== undefined
      ? { commands: catalog.commands.filter((command) => command.name === topic) }
      : catalog
  emitResult(payload, flags.compact)
}
