import { z } from 'zod'

export const EVALSCOPE_UPSTREAM_COMMIT = 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60' as const
export const EVALSCOPE_PLOTLY_ASSET_SHA256 =
  '6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603' as const

export const evalScopeClientConfigSchema = z
  .object({
    gatewayBase: z.literal('/evalscope-api'),
    apiBase: z.literal('/evalscope-api/api/v1'),
  })
  .strict()

export type EvalScopeClientConfig = z.infer<typeof evalScopeClientConfigSchema>

export const EVALSCOPE_CLIENT_CONFIG = evalScopeClientConfigSchema.parse({
  gatewayBase: '/evalscope-api',
  apiBase: '/evalscope-api/api/v1',
})
