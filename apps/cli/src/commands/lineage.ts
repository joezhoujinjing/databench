import { requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
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
