import { Dataset, defineTransform } from '@databench/engine'
import { z } from 'zod'

export const SampleNParamsSchema = z.object({
  n: z.number().int(),
  seed: z.number().int().default(0),
})
export type SampleNParams = z.infer<typeof SampleNParamsSchema>

export const sampleN = defineTransform(
  { name: 'sample_n', version: '1', params: SampleNParamsSchema },
  (dataset: Dataset, params: SampleNParams) => {
    let frame = dataset.toPolars()

    if (params.n < frame.height) {
      frame = frame.sample(params.n, undefined, false, params.seed)
    }

    return Dataset.fromFrame(frame, dataset.name)
  },
)
