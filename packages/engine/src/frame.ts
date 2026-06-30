import { COLUMNS } from '@databench/schema'
import pl, { type DataFrame } from 'nodejs-polars'

export type PolarsDataFrame = DataFrame

export type DatasetColumns = Record<(typeof COLUMNS)[number], Array<string | null>>

export const DATASET_FRAME_SCHEMA = Object.fromEntries(
  COLUMNS.map((column) => [column, pl.Utf8]),
) as Record<(typeof COLUMNS)[number], typeof pl.Utf8>

export function createDatasetFrame(columns: DatasetColumns): PolarsDataFrame {
  return pl.DataFrame(columns, { schema: DATASET_FRAME_SCHEMA })
}

export function emptyDatasetFrame(): PolarsDataFrame {
  return pl.DataFrame({}, { schema: DATASET_FRAME_SCHEMA })
}

export function concatDatasetFrames(frames: readonly PolarsDataFrame[]): PolarsDataFrame {
  return frames.length > 0 ? pl.concat([...frames]) : emptyDatasetFrame()
}
