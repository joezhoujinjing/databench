import {
  BadInputError,
  CursorPageRequestV2Schema,
  NotFoundError,
  PutRefRequestV2Schema,
} from '@databench/schema'
import {
  optBool,
  optString,
  pagination,
  requireExactPositionals,
  requirePositional,
} from '../args.js'
import { withV2Workspace, withWorkspace } from '../runtime.js'
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

export const v2RefCommands: CommandGroup = {
  summary: 'List, inspect, and compare-and-set v2 refs',
  verbs: {
    list: {
      summary: 'List one cursor page of v2 refs',
      positionals: [],
      output: 'json',
      options: { cursor: { type: 'string' }, limit: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 0, 'v2 ref list')
        const request = CursorPageRequestV2Schema.parse({
          ...(optString(values, 'cursor') === undefined
            ? {}
            : { cursor: optString(values, 'cursor') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withV2Workspace(flags, (workspace, operation) =>
          workspace.listRefs(request, { signal: operation.signal }),
        )
      },
    },

    show: {
      summary: 'Show one v2 ref and its current exact version',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 ref show <name>')
        const name = requirePositional(positionals, 0, 'v2 ref show: <name>')
        return withV2Workspace(flags, async (workspace, operation) => {
          const ref = await workspace.getRef(name, { signal: operation.signal })
          if (ref === null) {
            throw new NotFoundError(`V2 ref was not found: ${name}`, { ref_name: name })
          }
          return ref
        })
      },
    },

    move: {
      summary: 'CAS a v2 ref; provide --expected-version or explicitly read it with --use-current',
      positionals: [
        { name: 'name', required: true },
        { name: 'new-version', required: true },
      ],
      output: 'json',
      options: {
        'expected-version': { type: 'string' },
        'use-current': { type: 'boolean' },
        message: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 2, 'v2 ref move <name> <new-version>')
        const name = requirePositional(positionals, 0, 'v2 ref move: <name>')
        const newVersion = requirePositional(positionals, 1, 'v2 ref move: <new-version>')
        const suppliedExpected = optString(values, 'expected-version')
        const useCurrent = optBool(values, 'use-current')
        if ((suppliedExpected !== undefined) === useCurrent) {
          throw new BadInputError(
            'v2 ref move requires exactly one of --expected-version or --use-current',
          )
        }
        return withV2Workspace(flags, async (workspace, operation) => {
          const expectedVersion = useCurrent
            ? ((await workspace.getRef(name, { signal: operation.signal }))?.version ?? null)
            : (suppliedExpected ?? null)
          const request = PutRefRequestV2Schema.parse({
            new_version: newVersion,
            expected_version: expectedVersion,
            message: optString(values, 'message') ?? null,
          })
          return workspace.putRef(name, request, { signal: operation.signal })
        })
      },
    },
  },
}
