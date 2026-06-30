import { Dataset, defineTransform } from '@databench/engine'

export const dedup = defineTransform({ name: 'dedup', version: '1' }, (dataset: Dataset) => {
  const frame = dataset.toPolars().unique({ subset: ['id'], keep: 'first', maintainOrder: true })

  return Dataset.fromFrame(frame, dataset.name)
})
