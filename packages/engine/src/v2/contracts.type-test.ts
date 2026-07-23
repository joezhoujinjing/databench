import type { V2Dataset } from '../index.js'

declare const dataset: V2Dataset

dataset.identity.dataset_version.toUpperCase()
dataset.canonicalBytes.toFixed()
dataset.records()
dataset.get('rec_unknown')

// @ts-expect-error Snapshot identity is immutable.
dataset.identity.num_records = 0

// @ts-expect-error Physical layout does not belong to the logical dataset API.
dataset.layout

// @ts-expect-error Polars materialization is codec-private in v2.
dataset.toPolars()

// @ts-expect-error Construction is restricted to the validated static factory.
new V2Dataset([], 0)
