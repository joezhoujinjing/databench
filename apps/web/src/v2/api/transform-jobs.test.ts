import { describe, expect, test } from 'vitest'
import {
  cancelTransformJobV2,
  createBasicCleanJobV2,
  listTransformJobsV2,
  retryTransformJobV2,
} from './client.js'

const CACHE_KEY = 'a'.repeat(64)
const JOB_ID = `job_${CACHE_KEY}`
const INPUT = 'b'.repeat(64)
const job = {
  id: JOB_ID,
  cache_key: CACHE_KEY,
  operation: { name: 'basic-clean', version: '1' },
  input_dataset_versions: [INPUT],
  status: 'queued',
  attempt: 0,
  progress: null,
  input_count: 10,
  output_count: null,
  output_dataset_version: null,
  result_ref: null,
  cache_hit: false,
  error: null,
  created_at: '2026-07-25T12:00:00.000Z',
  started_at: null,
  finished_at: null,
}

describe('transform job API client', () => {
  test('uses fixed submit, list, cancel, and retry routes', async () => {
    const requests: Request[] = []
    const fetcher = async (request: Request): Promise<Response> => {
      requests.push(request.clone())
      const url = new URL(request.url)
      return Response.json(
        url.pathname === '/v2/transform-jobs' ? { items: [job], next_cursor: null } : job,
        { status: url.pathname.endsWith(':retry') || url.pathname.endsWith('/jobs') ? 202 : 200 },
      )
    }
    const connection = { base: 'https://api.example.test', fetch: fetcher, token: '' }

    await createBasicCleanJobV2({
      ...connection,
      request: { inputs: [INPUT], result_ref: 'clean-result' },
    })
    await listTransformJobsV2({ ...connection, cursor: null, limit: 20 })
    await cancelTransformJobV2({ ...connection, jobId: JOB_ID })
    await retryTransformJobV2({ ...connection, jobId: JOB_ID })

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'POST /v2/transforms/basic-clean/jobs',
        'GET /v2/transform-jobs',
        `POST /v2/transform-jobs/${JOB_ID}:cancel`,
        `POST /v2/transform-jobs/${JOB_ID}:retry`,
      ],
    )
    expect(await requests[0]?.json()).toEqual({ inputs: [INPUT], result_ref: 'clean-result' })
    expect(new URL(requests[1]?.url ?? '').searchParams.get('limit')).toBe('20')
  })
})
