import { parseArgs } from 'node:util'
import { BadInputError } from '@databench/schema'
import { v2ConverterCommands } from './commands/converter.js'
import { v2DatasetCommands } from './commands/dataset.js'
import { v2LineageCommands } from './commands/lineage.js'
import { v2RefCommands } from './commands/ref.js'
import { v2TransformCommands } from './commands/transform.js'
import type { GlobalFlags } from './config.js'
import { emitResult } from './output.js'
import { type CommandGroup, STREAMED, type Values } from './types.js'

const V2_COMMANDS: Record<string, CommandGroup> = {
  dataset: v2DatasetCommands,
  converter: v2ConverterCommands,
  transform: v2TransformCommands,
  ref: v2RefCommands,
  lineage: v2LineageCommands,
}

const HELP_TOKENS = new Set(['help', '--help', '-h'])

export async function dispatchV2(rest: readonly string[], flags: GlobalFlags): Promise<void> {
  const noun = rest[0]
  if (noun === undefined || HELP_TOKENS.has(noun)) {
    emitV2Help(rest[1], flags)
    return
  }

  const group = V2_COMMANDS[noun]
  if (group === undefined) {
    throw new BadInputError(
      `unknown v2 command: ${noun}. Available: ${Object.keys(V2_COMMANDS).join(', ')}. Run 'databench v2 help'.`,
    )
  }

  const candidateVerb = rest[1]
  if (candidateVerb !== undefined && HELP_TOKENS.has(candidateVerb)) {
    emitV2Help(noun, flags)
    return
  }
  const verbName =
    candidateVerb !== undefined && Object.hasOwn(group.verbs, candidateVerb)
      ? candidateVerb
      : group.defaultVerb
  if (verbName === undefined) {
    throw new BadInputError(
      `unknown subcommand for 'v2 ${noun}': ${candidateVerb ?? '(none)'}. Available: ${Object.keys(group.verbs).join(', ')}.`,
    )
  }
  const verb = group.verbs[verbName]
  if (verb === undefined) {
    throw new BadInputError(`unknown subcommand for 'v2 ${noun}': ${verbName}`)
  }

  const verbArgv =
    candidateVerb !== undefined && Object.hasOwn(group.verbs, candidateVerb)
      ? rest.slice(2)
      : rest.slice(1)
  let parsed: { values: Record<string, unknown>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: [...verbArgv],
      options: verb.options,
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    throw new BadInputError(
      error instanceof Error ? error.message : `invalid arguments for 'v2 ${noun} ${verbName}'`,
    )
  }

  const result = await verb.run({
    positionals: parsed.positionals,
    values: parsed.values as unknown as Values,
    flags,
  })
  if (result !== STREAMED) emitResult(result, flags.compact)
}

function emitV2Help(topic: string | undefined, flags: GlobalFlags): void {
  if (topic !== undefined && !Object.hasOwn(V2_COMMANDS, topic)) {
    throw new BadInputError(
      `unknown v2 command: ${topic}. Available: ${Object.keys(V2_COMMANDS).join(', ')}.`,
    )
  }
  const commands = Object.entries(V2_COMMANDS)
    .filter(([name]) => topic === undefined || name === topic)
    .map(([name, group]) => ({
      name,
      summary: group.summary,
      ...(group.defaultVerb === undefined ? {} : { default_verb: group.defaultVerb }),
      verbs: Object.entries(group.verbs).map(([verbName, verb]) => ({
        name: verbName,
        summary: verb.summary,
        output: verb.output ?? 'json',
        positionals: verb.positionals ?? [],
        options: Object.entries(verb.options).map(([name, spec]) => ({
          name,
          type: spec.type,
          ...(spec.short === undefined ? {} : { short: spec.short }),
          ...(spec.multiple === true ? { multiple: true } : {}),
        })),
      })),
    }))
  emitResult({ version: 'v2', commands }, flags.compact)
}
