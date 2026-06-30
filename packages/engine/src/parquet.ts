import { type Manifest, ManifestSchema } from '@databench/schema'
import pl from 'nodejs-polars'
import { Dataset } from './dataset.js'

export function toParquetBytes(dataset: Dataset): Buffer {
  return dataset.toPolars().writeParquet()
}

export function fromParquetBytes(
  bytes: Buffer | Uint8Array,
  manifest: Manifest | unknown,
): Dataset {
  const frame = pl.readParquet(Buffer.from(bytes))
  return new Dataset(frame, ManifestSchema.parse(manifest))
}
