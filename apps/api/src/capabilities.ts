import {
  type Capabilities,
  PostTrainingV2CapabilitySchema,
  serviceCapabilities,
} from '@databench/schema'
import { listTransforms, postTrainingV2Capability } from '@databench/workspace'

export function getCapabilities(v2: unknown = postTrainingV2Capability()): Capabilities {
  return serviceCapabilities({
    transforms: listTransforms().length > 0,
    post_training_v2: PostTrainingV2CapabilitySchema.parse(v2),
  })
}
