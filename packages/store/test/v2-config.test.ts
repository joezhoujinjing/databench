import { describe, expect, test } from 'vitest'
import { v2ObjectStoreConfigFromEnv } from '../src/index.js'

describe('v2 object-store environment config', () => {
  test('builds the production OSS defaults and explicit endpoint options', () => {
    expect(v2ObjectStoreConfigFromEnv({})).toEqual({
      kind: 'oss',
      bucket: 'databench',
      region: 'oss-cn-hangzhou',
      accessKeyId: '',
      accessKeySecret: '',
      secure: true,
      internal: false,
    })

    expect(
      v2ObjectStoreConfigFromEnv({
        DATABENCH_OBJECT_STORE: ' OSS ',
        OSS_ACCESS_KEY_ID: 'key',
        OSS_ACCESS_KEY_SECRET: 'secret',
        OSS_BUCKET: 'bucket',
        OSS_ENDPOINT: 'https://oss.example.test',
        OSS_INTERNAL: 'true',
        OSS_REGION: 'custom-region',
        OSS_SECURE: 'false',
      }),
    ).toEqual({
      kind: 'oss',
      bucket: 'bucket',
      region: 'custom-region',
      accessKeyId: 'key',
      accessKeySecret: 'secret',
      endpoint: 'https://oss.example.test',
      secure: false,
      internal: true,
    })
  })

  test('builds the S3/MinIO configuration without partial credentials', () => {
    expect(
      v2ObjectStoreConfigFromEnv({
        DATABENCH_OBJECT_STORE: 's3',
        S3_ACCESS_KEY_ID: 'incomplete',
        S3_BUCKET: 'local',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        S3_FORCE_PATH_STYLE: 'false',
      }),
    ).toEqual({
      kind: 's3',
      bucket: 'local',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: false,
    })

    expect(
      v2ObjectStoreConfigFromEnv({
        DATABENCH_OBJECT_STORE: 's3',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toMatchObject({ accessKeyId: 'key', secretAccessKey: 'secret' })
  })

  test('rejects unsupported providers', () => {
    expect(() => v2ObjectStoreConfigFromEnv({ DATABENCH_OBJECT_STORE: 'filesystem' })).toThrow(
      'unsupported DATABENCH_OBJECT_STORE: filesystem',
    )
  })
})
