import { ModelPageRequestV2Schema, NotFoundError } from '@databench/schema'
import { optString, requireExactPositionals, requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const modelCommands: CommandGroup = {
  summary: 'List and inspect logical Models in the registry',
  verbs: {
    list: {
      summary: 'List one stable page of Models',
      positionals: [],
      output: 'json',
      options: {
        search: { type: 'string' },
        archive: { type: 'string' },
        'source-kind': { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 0, 'model list')
        const request = ModelPageRequestV2Schema.parse({
          ...(optString(values, 'search') === undefined
            ? {}
            : { search: optString(values, 'search') }),
          ...(optString(values, 'archive') === undefined
            ? {}
            : { archive: optString(values, 'archive') }),
          ...(optString(values, 'source-kind') === undefined
            ? {}
            : { source_kind: optString(values, 'source-kind') }),
          ...(optString(values, 'cursor') === undefined
            ? {}
            : { cursor: optString(values, 'cursor') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withWorkspace(flags, (workspace, operation) =>
          workspace.listModels(request, { signal: operation.signal }),
        )
      },
    },

    show: {
      summary: 'Show one logical Model by immutable ID',
      positionals: [{ name: 'model-id', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'model show <model-id>')
        const modelId = requirePositional(positionals, 0, 'model show: <model-id>')
        return withWorkspace(flags, async (workspace, operation) => {
          const model = await workspace.getModel(modelId, { signal: operation.signal })
          if (model === null) {
            throw new NotFoundError(`Model was not found: ${modelId}`, { model_id: modelId })
          }
          return model
        })
      },
    },
  },
}
