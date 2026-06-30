import { Dataset, defineTransform } from '@databench/engine'
import pl from 'nodejs-polars'
import { z } from 'zod'

export const SignalFilterParamsSchema = z.object({
  key: z.string(),
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
})
export type SignalFilterParams = z.infer<typeof SignalFilterParamsSchema>

export const filterBySignal = defineTransform(
  { name: 'filter_by_signal', version: '1', params: SignalFilterParamsSchema },
  (dataset: Dataset, params: SignalFilterParams) => {
    const value = pl.col('signals').str.jsonPathMatch(`$.${params.key}`).cast(pl.Float64, false)
    let condition = pl.lit(true)

    if (params.min !== null) {
      condition = condition.and(value.gtEq(params.min))
    }

    if (params.max !== null) {
      condition = condition.and(value.ltEq(params.max))
    }

    return Dataset.fromFrame(dataset.toPolars().filter(condition), dataset.name)
  },
)
