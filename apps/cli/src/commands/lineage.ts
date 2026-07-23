import { LineagePageRequestV2Schema } from '@databench/schema'
import { optString, requireExactPositionals, requirePositional } from '../args.js'
import { withV2Workspace, withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const lineageCommands: CommandGroup = {
  summary: 'Show the provenance DAG for a dataset',
  defaultVerb: 'show',
  verbs: {
    show: {
      summary: 'Print the provenance DAG for a ref or version',
      positionals: [{ name: 'ref', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        const ref = requirePositional(positionals, 0, 'lineage: <ref>')
        return withWorkspace(flags, (workspace) => workspace.lineage(ref))
      },
    },
  },
}

export const v2LineageCommands: CommandGroup = {
  summary: 'Show bounded exact v2 dataset lineage',
  defaultVerb: 'show',
  verbs: {
    show: {
      summary: 'Show one bounded lineage page for a v2 ref or exact version',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'json',
      options: {
        'max-depth': { type: 'string' },
        'max-nodes': { type: 'string' },
        cursor: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 lineage show <ref-or-version>')
        const target = requirePositional(positionals, 0, 'v2 lineage show: <ref-or-version>')
        const request = LineagePageRequestV2Schema.parse({
          ...(optString(values, 'max-depth') === undefined
            ? {}
            : { max_depth: optString(values, 'max-depth') }),
          ...(optString(values, 'max-nodes') === undefined
            ? {}
            : { max_nodes: optString(values, 'max-nodes') }),
          ...(optString(values, 'cursor') === undefined
            ? {}
            : { cursor: optString(values, 'cursor') }),
        })
        return withV2Workspace(flags, (workspace, operation) =>
          workspace.lineage(target, request, { signal: operation.signal }),
        )
      },
    },
  },
}
