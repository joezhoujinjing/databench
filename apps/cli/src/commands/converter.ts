import {
  ConverterParamsV2Schema,
  ConverterRegistryPageV2Schema,
  NotFoundError,
} from '@databench/schema'
import { requireExactPositionals, requirePositional } from '../args.js'
import { withV2Workspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const v2ConverterCommands: CommandGroup = {
  summary: 'Inspect the complete v2 export converter registry',
  verbs: {
    list: {
      summary: 'List all v2 converters',
      positionals: [],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 0, 'v2 converter list')
        return withV2Workspace(flags, async (workspace) => {
          const items = [...workspace.listConverters()]
          return ConverterRegistryPageV2Schema.parse({ items, total: items.length })
        })
      },
    },
    show: {
      summary: 'Show one v2 converter descriptor',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 converter show <name>')
        const { name } = ConverterParamsV2Schema.parse({
          name: requirePositional(positionals, 0, 'v2 converter show: <name>'),
        })
        return withV2Workspace(flags, async (workspace) => {
          const descriptor = workspace.getConverter(name)
          if (descriptor === null) {
            throw new NotFoundError(`V2 converter was not found: ${name}`, { converter: name })
          }
          return descriptor
        })
      },
    },
  },
}
