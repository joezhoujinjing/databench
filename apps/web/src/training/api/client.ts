import { z } from 'zod'
import { type FetchLike, requestJson } from '@/api/client.js'

export const SWIFT_STUDIO_PATH = '/swift-studio/' as const
export const SWIFT_STUDIO_RUNTIME_PATH = '/swift-studio-runtime/runtime' as const
export const SWIFT_STUDIO_CAPABILITY_MANIFEST_SHA256 =
  '01d259849837484b8ed00c013ed53d45548a525384317b856edebee02d5956b4' as const

const runtimeShape = {
  ready: z.boolean(),
  service: z.literal('swift-studio-provider'),
  service_version: z.string().min(1),
  ms_swift_version: z.literal('4.4.2'),
  ms_swift_commit: z.literal('f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d'),
  gradio_version: z.literal('5.50.0'),
  torch_version: z.string().min(1),
  cuda_version: z.string().min(1).nullable(),
  gpu_available: z.boolean(),
  root_path: z.literal('/swift-studio'),
  capability_manifest_id: z.literal('swift-runtime-capabilities@1'),
  capability_manifest_phase: z.enum(['S1-in-progress', 'S1-complete']),
  capability_manifest_sha256: z.literal(SWIFT_STUDIO_CAPABILITY_MANIFEST_SHA256),
} as const

const SwiftStudioRuntimeSchema = z.discriminatedUnion('ready', [
  z
    .object({
      ...runtimeShape,
      ready: z.literal(false),
      surfaces: z.tuple([]),
      capabilities: z.tuple([z.literal('runtime-health')]),
    })
    .strict(),
  z
    .object({
      ...runtimeShape,
      ready: z.literal(true),
      surfaces: z.tuple([
        z.literal('llm_train'),
        z.literal('llm_rlhf'),
        z.literal('llm_grpo'),
        z.literal('llm_infer'),
        z.literal('llm_export'),
        z.literal('llm_eval'),
        z.literal('llm_sample'),
      ]),
      capabilities: z.tuple([z.literal('native-full-gradio'), z.literal('runtime-health')]),
    })
    .strict(),
])

export type SwiftStudioRuntime = z.infer<typeof SwiftStudioRuntimeSchema>

export class SwiftStudioRuntimeContractError extends Error {
  constructor() {
    super('Swift Studio runtime does not match the locked Databench contract')
    this.name = 'SwiftStudioRuntimeContractError'
  }
}

export async function getSwiftStudioRuntime(options: {
  readonly base: string
  readonly fetch?: FetchLike
  readonly signal?: AbortSignal
  readonly token: string
}): Promise<SwiftStudioRuntime> {
  const payload = await requestJson<unknown>(SWIFT_STUDIO_RUNTIME_PATH, options)
  const parsed = SwiftStudioRuntimeSchema.safeParse(payload)
  if (!parsed.success) throw new SwiftStudioRuntimeContractError()
  return parsed.data
}
