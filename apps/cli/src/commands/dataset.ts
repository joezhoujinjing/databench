import {
  AddRecordsV2OptionsSchema,
  assertExportFidelityAcceptedV2,
  BadInputError,
  ConverterNameV2Schema,
  ExportPlanV2Schema,
  ExportRequestV2Schema,
  InspectExportRequestV2Schema,
  IntegrityError,
  RecordPageRequestV2Schema,
} from '@databench/schema'
import {
  optBool,
  optString,
  parseV2JsonObjectFlag,
  requireExactPositionals,
  requirePositional,
} from '../args.js'
import { withWorkspace } from '../runtime.js'
import { readCliInput, writeCliFileAtomically, writeCliStdout } from '../streaming.js'
import { type CommandGroup, STREAMED } from '../types.js'

export const datasetCommands: CommandGroup = {
  summary: 'Ingest, inspect, audit, and export canonical datasets',
  verbs: {
    ingest: {
      summary: 'Ingest canonical JSONL from a file, or from stdin when file is -',
      positionals: [{ name: 'file', required: true }],
      output: 'json',
      options: {
        ref: { type: 'string' },
        'expected-ref-version': { type: 'string' },
        message: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'dataset ingest <file>')
        const path = requirePositional(positionals, 0, 'dataset ingest: <file>')
        const options = AddRecordsV2OptionsSchema.parse({
          ref: optString(values, 'ref') ?? null,
          expected_ref_version: optString(values, 'expected-ref-version') ?? null,
          message: optString(values, 'message') ?? null,
        })
        return withWorkspace(flags, async (workspace, operation) =>
          workspace.addJsonl(readCliInput(path, operation.signal), options, {
            signal: operation.signal,
          }),
        )
      },
    },

    show: {
      summary: 'Describe an exact dataset version or a ref resolved once',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'dataset show <ref-or-version>')
        const target = requirePositional(positionals, 0, 'dataset show: <ref-or-version>')
        return withWorkspace(flags, (workspace, operation) =>
          workspace.describeDataset(target, { signal: operation.signal }),
        )
      },
    },

    records: {
      summary: 'List a stable offset page of record summaries',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'json',
      options: { offset: { type: 'string' }, limit: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'dataset records <ref-or-version>')
        const target = requirePositional(positionals, 0, 'dataset records: <ref-or-version>')
        const request = RecordPageRequestV2Schema.parse({
          ...(optString(values, 'offset') === undefined
            ? {}
            : { offset: optString(values, 'offset') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withWorkspace(flags, (workspace, operation) =>
          workspace.getRecordPage(target, request, { signal: operation.signal }),
        )
      },
    },

    audit: {
      summary: 'Fully audit a committed dataset layout',
      positionals: [{ name: 'ref-or-version', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        requireExactPositionals(positionals, 1, 'dataset audit <ref-or-version>')
        const target = requirePositional(positionals, 0, 'dataset audit: <ref-or-version>')
        return withWorkspace(flags, (workspace, operation) =>
          workspace.audit(target, { signal: operation.signal }),
        )
      },
    },

    export: {
      summary: 'Inspect then export a dataset; --inspect prints the plan without exporting',
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
        requireExactPositionals(positionals, 1, 'dataset export <ref-or-version>')
        const target = requirePositional(positionals, 0, 'dataset export: <ref-or-version>')
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

        return withWorkspace(flags, async (workspace, operation) => {
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
            throw new IntegrityError('export plan changed after inspection', {
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
