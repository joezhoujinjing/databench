import { readFile } from 'node:fs/promises'
import {
  BadInputError,
  IngestSamplesRequestSchema,
  KINDS,
  type Kind,
  parseJsonValue,
  toJsonCompatible,
} from '@databench/schema'
import { optBool, optString, pagination, requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
import { type CommandGroup, STREAMED } from '../types.js'

function asKind(value: string): Kind {
  if ((KINDS as readonly string[]).includes(value)) {
    return value as Kind
  }
  throw new BadInputError(
    `invalid --kind ${JSON.stringify(value)}; expected one of ${KINDS.join(', ')}`,
  )
}

export const datasetCommands: CommandGroup = {
  summary: 'Ingest, inspect, and export dataset versions',
  verbs: {
    add: {
      summary:
        'Ingest a JSONL file, or with --samples a JSON file holding either a samples array or the API request body {samples,name?,message?}',
      positionals: [{ name: 'file', required: true }],
      output: 'json',
      options: {
        name: { type: 'string' },
        kind: { type: 'string' },
        source: { type: 'string' },
        message: { type: 'string' },
        samples: { type: 'boolean' },
      },
      run: ({ positionals, values, flags }) => {
        const path = requirePositional(positionals, 0, 'dataset add: <file>')
        const name = optString(values, 'name')
        const message = optString(values, 'message')
        return withWorkspace(flags, async (workspace) => {
          if (optBool(values, 'samples')) {
            // Accept a bare samples array OR the API request body shape
            // ({samples,name?,message?}). Use parseJsonValue (not JSON.parse) so
            // numeric lexemes (1.0 ≠ 1) survive and the version hash matches the
            // JSONL/HTTP/Python paths.
            const parsed = parseJsonValue(await readFile(path, 'utf8'))
            const body = IngestSamplesRequestSchema.parse(
              Array.isArray(parsed) ? { samples: parsed } : parsed,
            )
            // CLI --name/--message override the body's; otherwise the body wins
            // (mirrors the API, which reads name/message from the request body).
            const dataset = await workspace.addSamples(body.samples, {
              name: name ?? body.name,
              message: message ?? body.message,
            })
            return dataset.manifest
          }
          const kind = optString(values, 'kind')
          const source = optString(values, 'source')
          const dataset = await workspace.addJsonl(path, {
            ...(name !== undefined ? { name } : {}),
            ...(message !== undefined ? { message } : {}),
            ...(kind !== undefined ? { kind: asKind(kind) } : {}),
            ...(source !== undefined ? { source } : {}),
          })
          return dataset.manifest
        })
      },
    },

    show: {
      summary: 'Show a dataset manifest by ref or version',
      positionals: [{ name: 'ref', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        const ref = requirePositional(positionals, 0, 'dataset show: <ref>')
        return withWorkspace(flags, async (workspace) => (await workspace.get(ref)).manifest)
      },
    },

    samples: {
      summary: 'Print a page of samples from a dataset',
      positionals: [{ name: 'ref', required: true }],
      output: 'json',
      options: { limit: { type: 'string' }, offset: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        const ref = requirePositional(positionals, 0, 'dataset samples: <ref>')
        const { limit, offset } = pagination(values)
        return withWorkspace(flags, async (workspace) => {
          const dataset = await workspace.get(ref)
          const items = [...dataset.toSamples(offset, limit)].map(toJsonCompatible)
          return { total: dataset.length, limit, offset, items }
        })
      },
    },

    export: {
      summary:
        'Export a dataset: with --out/-o writes the file and prints {path} JSON; otherwise streams raw NDJSON to stdout',
      positionals: [{ name: 'ref', required: true }],
      output: 'ndjson',
      options: { fmt: { type: 'string' }, out: { type: 'string', short: 'o' } },
      run: ({ positionals, values, flags }) => {
        const ref = requirePositional(positionals, 0, 'dataset export: <ref>')
        const fmt = optString(values, 'fmt') ?? 'messages-jsonl'
        const out = optString(values, 'out')
        return withWorkspace(flags, async (workspace) => {
          if (out !== undefined) {
            const path = await workspace.export(ref, out, fmt)
            return { path }
          }
          const { lines } = await workspace.exportJsonl(ref, fmt)
          for (const line of lines) {
            process.stdout.write(line)
          }
          // NDJSON already streamed; signal the router not to JSON-wrap.
          return STREAMED
        })
      },
    },
  },
}
