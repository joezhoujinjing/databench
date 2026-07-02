import { BadInputError, NotFoundError } from '@databench/schema'
import { getTransform, listTransforms } from '@databench/workspace'
import { z } from 'zod'
import { optString, pagination, parseJsonFlag, requirePositional, stringList } from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const transformCommands: CommandGroup = {
  summary: 'List and run built-in transforms',
  verbs: {
    list: {
      summary: 'List available transforms with their params JSON schema',
      positionals: [],
      output: 'json',
      options: { limit: { type: 'string' }, offset: { type: 'string' } },
      run: ({ values }) => {
        const { limit, offset } = pagination(values)
        const transforms = listTransforms().sort((left, right) =>
          left.name.localeCompare(right.name),
        )
        const items = transforms.slice(offset, offset + limit).map((transform) => ({
          name: transform.name,
          version: transform.version,
          params_schema:
            transform.paramsSchema === null
              ? null
              : (z.toJSONSchema(transform.paramsSchema) as Record<string, unknown>),
        }))
        return Promise.resolve({ total: transforms.length, limit, offset, items })
      },
    },

    run: {
      summary: 'Run a transform over one or more input datasets and register the output',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {
        input: { type: 'string', multiple: true },
        params: { type: 'string' },
        ref: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        const name = requirePositional(positionals, 0, 'transform run: <name>')
        const transform = getTransform(name)
        if (transform === null) {
          throw new NotFoundError(`unknown transform: ${name}`, { transform: name })
        }
        const inputs = stringList(values, 'input')
        if (inputs.length === 0) {
          throw new BadInputError('transform run: at least one --input <ref> is required')
        }
        const paramsText = optString(values, 'params')
        const ref = optString(values, 'ref')
        return withWorkspace(flags, async (workspace) => {
          const output = await workspace.run(transform, inputs, {
            ...(paramsText !== undefined
              ? { params: parseJsonFlag(paramsText, '--params') as Record<string, unknown> }
              : {}),
            ...(ref !== undefined ? { ref } : {}),
          })
          return output.manifest
        })
      },
    },
  },
}
