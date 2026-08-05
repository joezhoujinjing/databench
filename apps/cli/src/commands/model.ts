import {
  BadInputError,
  CommitModelRegistrationRequestV2Schema,
  DigestHexV2Schema,
  ModelPageRequestV2Schema,
  ModelRegistrationInspectRequestV2Schema,
  ModelVersionDeploymentPageRequestV2Schema,
  ModelVersionPageRequestV2Schema,
  NotFoundError,
} from '@databench/schema'
import type { V2Workspace } from '@databench/workspace'
import { optString, requireExactPositionals, requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
import { readCliJsonInput, writeCliJsonFileAtomically } from '../streaming.js'
import type { CommandGroup, Values, Verb } from '../types.js'

const MODEL_REGISTRATION_JSON_LIMITS = Object.freeze({
  maxBytes: 128 * 1024,
  maxDepth: 9,
})

export const modelCommands: CommandGroup = {
  summary: 'Inspect, register, and operate logical Models and their Deployments',
  verbs: {
    list: {
      summary: 'List one stable page of Models',
      positionals: [],
      output: 'json',
      options: {
        search: { type: 'string' },
        archive: { type: 'string' },
        'source-kind': { type: 'string' },
        'source-mutability': { type: 'string' },
        'verification-level': { type: 'string' },
        'task-family': { type: 'string' },
        'artifact-kind': { type: 'string' },
        'artifact-id': { type: 'string' },
        alias: { type: 'string' },
        'deployment-lifecycle': { type: 'string' },
        'deployment-health': { type: 'string' },
        tag: { type: 'string' },
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
          ...(optString(values, 'source-mutability') === undefined
            ? {}
            : { source_mutability: optString(values, 'source-mutability') }),
          ...(optString(values, 'verification-level') === undefined
            ? {}
            : { verification_level: optString(values, 'verification-level') }),
          ...(optString(values, 'task-family') === undefined
            ? {}
            : { task_family: optString(values, 'task-family') }),
          ...(optString(values, 'artifact-kind') === undefined
            ? {}
            : { artifact_kind: optString(values, 'artifact-kind') }),
          ...(optString(values, 'artifact-id') === undefined
            ? {}
            : { artifact_id: optString(values, 'artifact-id') }),
          ...(optString(values, 'alias') === undefined
            ? {}
            : { alias: optString(values, 'alias') }),
          ...(optString(values, 'deployment-lifecycle') === undefined
            ? {}
            : { deployment_lifecycle: optString(values, 'deployment-lifecycle') }),
          ...(optString(values, 'deployment-health') === undefined
            ? {}
            : { deployment_health: optString(values, 'deployment-health') }),
          ...(optString(values, 'tag') === undefined ? {} : { tag: optString(values, 'tag') }),
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

    versions: {
      summary: 'List one stable page of immutable Versions for a Model',
      positionals: [{ name: 'model-id', required: true }],
      output: 'json',
      options: { cursor: { type: 'string' }, limit: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'model versions <model-id>')
        const modelId = requirePositional(positionals, 0, 'model versions: <model-id>')
        const request = ModelVersionPageRequestV2Schema.parse({
          ...(optString(values, 'cursor') === undefined
            ? {}
            : { cursor: optString(values, 'cursor') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withWorkspace(flags, (workspace, operation) =>
          workspace.listModelVersions(modelId, request, { signal: operation.signal }),
        )
      },
    },

    'registration inspect': {
      summary: 'Inspect a bounded strict registration request without writing',
      positionals: [],
      output: 'json',
      options: { input: { type: 'string' }, output: { type: 'string', short: 'o' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 0, 'model registration inspect')
        const input = requireStringOption(values, 'input', '--input <request.json|->')
        const output = optString(values, 'output')
        return withWorkspace(flags, async (workspace, operation) => {
          const request = ModelRegistrationInspectRequestV2Schema.parse(
            await readCliJsonInput(input, operation.signal, MODEL_REGISTRATION_JSON_LIMITS),
          )
          const plan = await workspace.inspectModelRegistration(request, {
            signal: operation.signal,
          })
          if (output === undefined) return plan
          const path = await writeCliJsonFileAtomically(
            output,
            plan,
            operation.signal,
            flags.compact,
          )
          return {
            path,
            plan_profile: plan.plan_profile,
            registration_digest: plan.registration_digest,
          }
        })
      },
    },

    'registration commit': {
      summary: 'Commit the original strict request with its exact inspected digest',
      positionals: [],
      output: 'json',
      options: { input: { type: 'string' }, 'expected-digest': { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 0, 'model registration commit')
        const input = requireStringOption(values, 'input', '--input <request.json|->')
        const expectedDigest = DigestHexV2Schema.parse(
          requireStringOption(values, 'expected-digest', '--expected-digest <hex64>'),
        )
        return withWorkspace(flags, async (workspace, operation) => {
          const request = ModelRegistrationInspectRequestV2Schema.parse(
            await readCliJsonInput(input, operation.signal, MODEL_REGISTRATION_JSON_LIMITS),
          )
          const commit = CommitModelRegistrationRequestV2Schema.parse({
            request,
            expected_registration_digest: expectedDigest,
          })
          return await workspace.commitModelRegistration(commit, { signal: operation.signal })
        })
      },
    },

    'deployment list': {
      summary: 'List one stable page of Deployments for a Model Version',
      positionals: [{ name: 'version-id', required: true }],
      output: 'json',
      options: {
        lifecycle: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        requireExactPositionals(positionals, 1, 'model deployment list <version-id>')
        const versionId = requirePositional(positionals, 0, 'model deployment list: <version-id>')
        const request = ModelVersionDeploymentPageRequestV2Schema.parse({
          ...(optString(values, 'lifecycle') === undefined
            ? {}
            : { lifecycle: optString(values, 'lifecycle') }),
          ...(optString(values, 'cursor') === undefined
            ? {}
            : { cursor: optString(values, 'cursor') }),
          ...(optString(values, 'limit') === undefined
            ? {}
            : { limit: optString(values, 'limit') }),
        })
        return withWorkspace(flags, (workspace, operation) =>
          workspace.listModelVersionDeployments(versionId, request, {
            signal: operation.signal,
          }),
        )
      },
    },

    'deployment activate': deploymentAction(
      'activate',
      (workspace, versionId, deploymentId, signal) =>
        workspace.activateModelVersionDeployment(versionId, deploymentId, { signal }),
    ),
    'deployment check': deploymentAction('check', (workspace, versionId, deploymentId, signal) =>
      workspace.checkModelVersionDeployment(versionId, deploymentId, { signal }),
    ),
    'deployment disable': deploymentAction(
      'disable',
      (workspace, versionId, deploymentId, signal) =>
        workspace.disableModelVersionDeployment(versionId, deploymentId, { signal }),
    ),
  },
}

function deploymentAction(
  action: 'activate' | 'check' | 'disable',
  invoke: (
    workspace: V2Workspace,
    versionId: string,
    deploymentId: string,
    signal: AbortSignal,
  ) => Promise<unknown>,
): Verb {
  return {
    summary: `${capitalize(action)} one Model Version Deployment`,
    positionals: [
      { name: 'version-id', required: true },
      { name: 'deployment-id', required: true },
    ],
    output: 'json' as const,
    options: {},
    run: ({ positionals, flags }) => {
      requireExactPositionals(
        positionals,
        2,
        `model deployment ${action} <version-id> <deployment-id>`,
      )
      const versionId = requirePositional(
        positionals,
        0,
        `model deployment ${action}: <version-id>`,
      )
      const deploymentId = requirePositional(
        positionals,
        1,
        `model deployment ${action}: <deployment-id>`,
      )
      return withWorkspace(flags, (workspace, operation) =>
        invoke(workspace, versionId, deploymentId, operation.signal),
      )
    },
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function requireStringOption(values: Values, key: string, usage: string): string {
  const value = optString(values, key)
  if (value === undefined || value.length === 0) {
    throw new BadInputError(`${usage} is required`)
  }
  return value
}
