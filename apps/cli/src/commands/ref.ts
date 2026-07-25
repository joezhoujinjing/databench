import {
  BadInputError,
  CursorPageRequestV2Schema,
  DeleteRefRequestV2Schema,
  NotFoundError,
  PutRefRequestV2Schema,
  RestoreRefRequestV2Schema,
} from '@databench/schema'
import { optBool, optString, requireExactPositionals, requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const refCommands: CommandGroup = {
  summary: 'List, inspect, move, trash, and restore refs with compare-and-set safety',
  verbs: {
    list: {
      summary: 'List one cursor page of refs',
      positionals: [],
      output: 'json',
      options: { cursor: { type: 'string' }, limit: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 0, 'ref list')
        const request = CursorPageRequestV2Schema.parse({
          ...(optString(values, 'cursor') === undefined
            ? {}
            : { cursor: optString(values, 'cursor') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withWorkspace(flags, (workspace, operation) =>
          workspace.listRefs(request, { signal: operation.signal }),
        )
      },
    },

    show: {
      summary: 'Show one ref and its current exact version',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'ref show <name>')
        const name = requirePositional(positionals, 0, 'ref show: <name>')
        return withWorkspace(flags, async (workspace, operation) => {
          const ref = await workspace.getRef(name, { signal: operation.signal })
          if (ref === null) {
            throw new NotFoundError(`ref was not found: ${name}`, { ref_name: name })
          }
          return ref
        })
      },
    },

    trash: {
      summary: 'List one cursor page of deleted refs',
      positionals: [],
      output: 'json',
      options: { cursor: { type: 'string' }, limit: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 0, 'ref trash')
        const request = CursorPageRequestV2Schema.parse({
          ...(optString(values, 'cursor') === undefined
            ? {}
            : { cursor: optString(values, 'cursor') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withWorkspace(flags, (workspace, operation) =>
          workspace.listDeletedRefs(request, { signal: operation.signal }),
        )
      },
    },

    move: {
      summary: 'CAS a ref; provide --expected-version or explicitly read it with --use-current',
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
        requireExactPositionals(positionals, 2, 'ref move <name> <new-version>')
        const name = requirePositional(positionals, 0, 'ref move: <name>')
        const newVersion = requirePositional(positionals, 1, 'ref move: <new-version>')
        const suppliedExpected = optString(values, 'expected-version')
        const useCurrent = optBool(values, 'use-current')
        if ((suppliedExpected !== undefined) === useCurrent) {
          throw new BadInputError(
            'ref move requires exactly one of --expected-version or --use-current',
          )
        }
        return withWorkspace(flags, async (workspace, operation) => {
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

    delete: {
      summary: 'CAS-move a ref to recoverable trash; provide --expected-version or --use-current',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {
        'expected-version': { type: 'string' },
        'use-current': { type: 'boolean' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'ref delete <name>')
        const name = requirePositional(positionals, 0, 'ref delete: <name>')
        const suppliedExpected = optString(values, 'expected-version')
        const useCurrent = optBool(values, 'use-current')
        if ((suppliedExpected !== undefined) === useCurrent) {
          throw new BadInputError(
            'ref delete requires exactly one of --expected-version or --use-current',
          )
        }
        return withWorkspace(flags, async (workspace, operation) => {
          let expectedVersion = suppliedExpected
          if (useCurrent) {
            const current =
              (await workspace.getRef(name, { signal: operation.signal })) ??
              (await workspace.getDeletedRef(name, { signal: operation.signal }))
            if (current === null) {
              throw new NotFoundError(`ref was not found: ${name}`, { ref_name: name })
            }
            expectedVersion = current.version
          }
          const request = DeleteRefRequestV2Schema.parse({
            expected_version: expectedVersion,
          })
          return workspace.deleteRef(name, request, { signal: operation.signal })
        })
      },
    },

    restore: {
      summary:
        'CAS-restore a deleted ref; provide --expected-version or read it with --use-current',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {
        'expected-version': { type: 'string' },
        'use-current': { type: 'boolean' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'ref restore <name>')
        const name = requirePositional(positionals, 0, 'ref restore: <name>')
        const suppliedExpected = optString(values, 'expected-version')
        const useCurrent = optBool(values, 'use-current')
        if ((suppliedExpected !== undefined) === useCurrent) {
          throw new BadInputError(
            'ref restore requires exactly one of --expected-version or --use-current',
          )
        }
        return withWorkspace(flags, async (workspace, operation) => {
          let expectedVersion = suppliedExpected
          if (useCurrent) {
            const current =
              (await workspace.getDeletedRef(name, { signal: operation.signal })) ??
              (await workspace.getRef(name, { signal: operation.signal }))
            if (current === null) {
              throw new NotFoundError(`ref was not found: ${name}`, { ref_name: name })
            }
            expectedVersion = current.version
          }
          const request = RestoreRefRequestV2Schema.parse({
            expected_version: expectedVersion,
          })
          return workspace.restoreRef(name, request, { signal: operation.signal })
        })
      },
    },
  },
}
