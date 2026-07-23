export {
  type CreateV2TransformContextInput,
  createDeterministicRngV2,
  createV2TransformContext,
} from './context.js'
export type {
  DeterministicRngV2,
  EventIdentityRequestV2,
  RootIdentityRequestV2,
  V2IdentityAllocator,
  V2TransformContext,
  V2TransformDefinition,
  V2TransformIdentityMode,
  V2TransformRegistryDescriptor,
  V2TransformResourceEstimate,
} from './contracts.js'
export {
  type AppendEvidenceV2Params,
  AppendEvidenceV2ParamsSchema,
  appendEvidenceV2,
  type PromptRewriteV2Params,
  PromptRewriteV2ParamsSchema,
  promptRewriteV2,
  type SampleV2Params,
  SampleV2ParamsSchema,
  type SelectionUpdateV2Params,
  SelectionUpdateV2ParamsSchema,
  type SubsetV2Params,
  SubsetV2ParamsSchema,
  sampleV2,
  selectionUpdateV2,
  subsetV2,
} from './operations.js'
export {
  type DefineV2TransformOptions,
  defineV2Transform,
  V2TransformRegistry,
} from './registry.js'

import {
  appendEvidenceV2,
  promptRewriteV2,
  sampleV2,
  selectionUpdateV2,
  subsetV2,
} from './operations.js'
import { V2TransformRegistry } from './registry.js'

export const BUILTIN_V2_TRANSFORMS = Object.freeze({
  'append-evidence': appendEvidenceV2,
  'prompt-rewrite': promptRewriteV2,
  sample: sampleV2,
  'selection-update': selectionUpdateV2,
  subset: subsetV2,
})

export const BUILTIN_V2_TRANSFORM_REGISTRY = new V2TransformRegistry(
  Object.values(BUILTIN_V2_TRANSFORMS),
)
