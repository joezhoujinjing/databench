import { z } from 'zod'
import { API_VERSION, MIN_CLIENT } from './constants.js'
import {
  type PostTrainingV2Capability,
  PostTrainingV2CapabilitySchema,
  V2_RECORD_SCHEMA_VERSIONS,
} from './v2/contracts.js'

export const HealthInfoSchema = z
  .object({
    status: z.literal('ok'),
    workspace_root: z.string(),
    version: z.string(),
  })
  .meta({ id: 'HealthInfo' })
export type HealthInfo = z.infer<typeof HealthInfoSchema>

export const VersionInfoSchema = z
  .strictObject({
    api_version: z.literal(API_VERSION).default(API_VERSION),
    service_version: z.string(),
    schema_version: z.literal(V2_RECORD_SCHEMA_VERSIONS[0]).default(V2_RECORD_SCHEMA_VERSIONS[0]),
  })
  .meta({ id: 'VersionInfo' })
export type VersionInfo = z.infer<typeof VersionInfoSchema>

export const CapabilitiesSchema = z
  .strictObject({
    api_version: z.literal(API_VERSION).default(API_VERSION),
    min_client: z.string().default(MIN_CLIENT),
    post_training_v2: PostTrainingV2CapabilitySchema,
  })
  .meta({ id: 'Capabilities' })
export type Capabilities = z.infer<typeof CapabilitiesSchema>

export function serviceCapabilities(postTrainingV2: PostTrainingV2Capability): Capabilities {
  return {
    api_version: API_VERSION,
    min_client: MIN_CLIENT,
    post_training_v2: postTrainingV2,
  }
}
