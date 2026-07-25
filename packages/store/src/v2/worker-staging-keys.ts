const JOB_ID = /^job_[0-9a-f]{64}$/

export type WorkerStagingLogicalNameV1 = 'input' | 'output'

export interface WorkerStagingObjectRefV1 {
  readonly jobId: string
  readonly attempt: number
  readonly logicalName: WorkerStagingLogicalNameV1
}

export function workerStagingKeyV1(input: WorkerStagingObjectRefV1): string {
  if (!JOB_ID.test(input.jobId)) {
    throw new TypeError('Worker staging job ID must be job_ plus 64 lowercase hex characters')
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 2_147_483_647) {
    throw new TypeError('Worker staging attempt must be a positive PostgreSQL integer')
  }
  if (input.logicalName !== 'input' && input.logicalName !== 'output') {
    throw new TypeError('Worker staging logical name is invalid')
  }
  return `staging/worker/v1/${input.jobId}/${input.attempt}/${input.logicalName}.jsonl`
}
