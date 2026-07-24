import {
  type Capabilities,
  PostTrainingV2CapabilitySchema,
  serviceCapabilities,
} from '@databench/schema'
import { postTrainingV2Capability } from '@databench/workspace'

export function getCapabilities(v2: unknown = postTrainingV2Capability()): Capabilities {
  return serviceCapabilities(PostTrainingV2CapabilitySchema.parse(v2))
}
