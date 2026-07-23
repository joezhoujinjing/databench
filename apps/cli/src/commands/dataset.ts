import { readFile } from 'node:fs/promises'
import {
  AddRecordsV2OptionsSchema,
  assertExportFidelityAcceptedV2,
  BadInputError,
  ConverterNameV2Schema,
  ExportPlanV2Schema,
  ExportRequestV2Schema,
  IngestSamplesRequestSchema,
  InspectExportRequestV2Schema,
  IntegrityError,
  KINDS,
  type Kind,
  parseJsonValue,
  RecordPageRequestV2Schema,
  toJsonCompatible,
} from '@databench/schema'
import {
  optBool,
  optString,
  pagination,
  parseV2JsonObjectFlag,
  requireExactPositionals,
  requirePositional,
} from '../args.js'
import { withV2Workspace, withWorkspace } from '../runtime.js'
import { readCliInput, writeCliFileAtomically, writeCliStdout } from '../streaming.js'
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

export const v2DatasetCommands: CommandGroup = {
  summary: 'Ingest, inspect, audit, and export canonical v2 datasets',
  verbs: {
    ingest: {
      summary: 'Ingest canonical v2 JSONL from a file, or from stdin when file is -',
      positionals: [{ name: 'file', required: true }],
      output: 'json',
      options: {
        ref: { type: 'string' },
        'expected-ref-version': { type: 'string' },
        message: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 dataset ingest <file>')
        const path = requirePositional(positionals, 0, 'v2 dataset ingest: <file>')
        const options = AddRecordsV2OptionsSchema.parse({
          ref: optString(values, 'ref') ?? null,
          expected_ref_version: optString(values, 'expected-ref-version') ?? null,
          message: optString(values, 'message') ?? null,
        })
        return withV2Workspace(flags, async (workspace, operation) =>
          workspace.addJsonl(readCliInput(path, operation.signal), options, {
            signal: operation.signal,
          }),
        )
      },
    },

    show: {
      summary: 'Describe an exact v2 dataset version or a ref resolved once',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 dataset show <ref-or-version>')
        const target = requirePositional(positionals, 0, 'v2 dataset show: <ref-or-version>')
        return withV2Workspace(flags, (workspace, operation) =>
          workspace.describeDataset(target, { signal: operation.signal }),
        )
      },
    },

    records: {
      summary: 'List a stable offset page of v2 record summaries',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'json',
      options: { offset: { type: 'string' }, limit: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 dataset records <ref-or-version>')
        const target = requirePositional(positionals, 0, 'v2 dataset records: <ref-or-version>')
        const request = RecordPageRequestV2Schema.parse({
          ...(optString(values, 'offset') === undefined
            ? {}
            : { offset: optString(values, 'offset') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withV2Workspace(flags, (workspace, operation) =>
          workspace.getRecordPage(target, request, { signal: operation.signal }),
        )
      },
    },

    audit: {
      summary: 'Fully audit a committed v2 dataset layout',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 dataset audit <ref-or-version>')
        const target = requirePositional(positionals, 0, 'v2 dataset audit: <ref-or-version>')
        return withV2Workspace(flags, (workspace, operation) =>
          workspace.audit(target, { signal: operation.signal }),
        )
      },
    },

    export: {
      summary: 'Inspect then export a v2 dataset; --inspect prints the plan without exporting',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'binary',
      options: {
        converter: { type: 'string' },
        options: { type: 'string' },
        inspect: { type: 'boolean' },
        'accept-fidelity': { type: 'string' },
        output: { type: 'string', short: 'o' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'v2 dataset export <ref-or-version>')
        const target = requirePositional(positionals, 0, 'v2 dataset export: <ref-or-version>')
        const converter = ConverterNameV2Schema.parse(
          optString(values, 'converter') ?? 'canonical-jsonl',
        )
        const options = parseV2JsonObjectFlag(values, 'options')
        const inspectOnly = optBool(values, 'inspect')
        const output = optString(values, 'output')
        const acceptedFidelity = optString(values, 'accept-fidelity') ?? null
        if (inspectOnly && output !== undefined) {
          throw new BadInputError('--output cannot be used with --inspect')
        }
        if (inspectOnly && acceptedFidelity !== null) {
          throw new BadInputError('--accept-fidelity cannot be used with --inspect')
        }
        const inspectRequest = InspectExportRequestV2Schema.parse({ converter, options })

        return withV2Workspace(flags, async (workspace, operation) => {
          const plan = ExportPlanV2Schema.parse(
            await workspace.inspectExport(target, inspectRequest, {
              signal: operation.signal,
            }),
          )
          if (inspectOnly) return plan

          const request = ExportRequestV2Schema.parse({
            converter,
            options,
            accepted_fidelity_digest: acceptedFidelity,
          })
          assertExportFidelityAcceptedV2(plan, request.accepted_fidelity_digest)
          const exported = await workspace.export(plan.dataset_version, request, {
            signal: operation.signal,
          })
          const exportedPlan = ExportPlanV2Schema.parse(exported.plan)
          if (
            exportedPlan.fidelity_digest !== plan.fidelity_digest ||
            exportedPlan.suggested_filename !== plan.suggested_filename
          ) {
            throw new IntegrityError('V2 export plan changed after inspection', {
              reason: 'cli_export_plan_changed_after_inspect',
              dataset_version: plan.dataset_version,
            })
          }
          if (output !== undefined) {
            const path = await writeCliFileAtomically(output, exported.bytes, operation.signal)
            return { path, plan: exportedPlan }
          }
          await writeCliStdout(exported.bytes, exportedPlan.media_type, operation)
          return STREAMED
        })
      },
    },
  },
}
