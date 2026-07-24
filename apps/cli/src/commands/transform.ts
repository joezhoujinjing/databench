import {
  RunTransformRequestV2Schema,
  TransformParamsV2Schema,
  TransformRegistryPageV2Schema,
} from '@databench/schema'
import {
  optString,
  parseV2JsonObjectFlag,
  requireExactPositionals,
  requirePositional,
  stringList,
} from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const transformCommands: CommandGroup = {
  summary: 'List and run deterministic transforms',
  verbs: {
    list: {
      summary: 'List the complete transform registry',
      positionals: [],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 0, 'transform list')
        return withWorkspace(flags, async (workspace) => {
          const items = [...workspace.listTransforms()]
          return TransformRegistryPageV2Schema.parse({ items, total: items.length })
        })
      },
    },

    run: {
      summary: 'Run a transform with ordered exact/ref inputs',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {
        input: { type: 'string', multiple: true },
        params: { type: 'string' },
        ref: { type: 'string' },
        'expected-ref-version': { type: 'string' },
        message: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'transform run <name>')
        const { name } = TransformParamsV2Schema.parse({
          name: requirePositional(positionals, 0, 'transform run: <name>'),
        })
        const request = RunTransformRequestV2Schema.parse({
          inputs: stringList(values, 'input'),
          params: parseV2JsonObjectFlag(values, 'params'),
          ref: optString(values, 'ref') ?? null,
          expected_ref_version: optString(values, 'expected-ref-version') ?? null,
          message: optString(values, 'message') ?? null,
        })
        return withWorkspace(flags, (workspace, operation) =>
          workspace.runTransform(name, request, { signal: operation.signal }),
        )
      },
    },
  },
}
