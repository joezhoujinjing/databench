import {
  ConverterParamsV2Schema,
  ConverterRegistryPageV2Schema,
  NotFoundError,
} from '@databench/schema'
import { requireExactPositionals, requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const converterCommands: CommandGroup = {
  summary: 'Inspect the export converter registry',
  verbs: {
    list: {
      summary: 'List all converters',
      positionals: [],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 0, 'converter list')
        return withWorkspace(flags, async (workspace) => {
          const items = [...workspace.listConverters()]
          return ConverterRegistryPageV2Schema.parse({ items, total: items.length })
        })
      },
    },
    show: {
      summary: 'Show one converter descriptor',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'converter show <name>')
        const { name } = ConverterParamsV2Schema.parse({
          name: requirePositional(positionals, 0, 'converter show: <name>'),
        })
        return withWorkspace(flags, async (workspace) => {
          const descriptor = workspace.getConverter(name)
          if (descriptor === null) {
            throw new NotFoundError(`converter was not found: ${name}`, { converter: name })
          }
          return descriptor
        })
      },
    },
  },
}
