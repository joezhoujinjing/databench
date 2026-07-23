import { IntegrityError } from '@databench/schema'

export type RecordJsonV1IntegrityReason =
  | 'parquet_unreadable'
  | 'schema_mismatch'
  | 'null_value'
  | 'row_count_mismatch'
  | 'row_order_mismatch'
  | 'record_json_invalid'
  | 'record_json_noncanonical'
  | 'record_id_mismatch'
  | 'record_digest_mismatch'
  | 'duplicate_record_id'
  | 'digest_collision'
  | 'dataset_identity_mismatch'

export interface RecordJsonV1IntegrityDetail {
  readonly layout_version: 'record-json-v1'
  readonly reason: RecordJsonV1IntegrityReason
  readonly row_index?: number
  readonly column?: string
  readonly expected?: string | number | null
  readonly actual?: string | number | null
}

export class RecordJsonV1IntegrityError extends IntegrityError {
  override readonly name = 'RecordJsonV1IntegrityError'
  readonly reason: RecordJsonV1IntegrityReason

  constructor(
    reason: RecordJsonV1IntegrityReason,
    message: string,
    detail: Omit<RecordJsonV1IntegrityDetail, 'layout_version' | 'reason'> = {},
  ) {
    const completeDetail: RecordJsonV1IntegrityDetail = Object.freeze({
      layout_version: 'record-json-v1',
      reason,
      ...detail,
    })
    super(message, completeDetail)
    this.reason = reason
  }
}
