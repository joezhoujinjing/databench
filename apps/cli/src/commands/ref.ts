import { NotFoundError } from '@databench/schema'
import { pagination, requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const refCommands: CommandGroup = {
  summary: 'List and resolve named dataset refs',
  verbs: {
    list: {
      summary: 'List refs (name → version) whose dataset objects exist',
      positionals: [],
      output: 'json',
      options: { limit: { type: 'string' }, offset: { type: 'string' } },
      run: ({ values, flags }) => {
        const { limit, offset } = pagination(values)
        return withWorkspace(flags, async (workspace) => {
          const refs = Object.entries(await workspace.listRefs()).sort(([left], [right]) =>
            left.localeCompare(right),
          )
          const items = refs.slice(offset, offset + limit).map(([name, version]) => ({
            name,
            version,
          }))
          return { total: refs.length, limit, offset, items }
        })
      },
    },

    resolve: {
      summary: 'Resolve a ref name to its dataset version',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        const name = requirePositional(positionals, 0, 'ref resolve: <name>')
        return withWorkspace(flags, async (workspace) => {
          const version = await workspace.getRef(name)
          if (version === null) {
            throw new NotFoundError(`unknown ref: ${name}`, { ref: name })
          }
          return { name, version }
        })
      },
    },
  },
}
