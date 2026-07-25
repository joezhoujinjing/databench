import type { OssConditionalObjectStoreV2Config } from './oss-adapter.js'
import type { S3ConditionalObjectStoreV2Config } from './s3-adapter.js'

export type V2ObjectStoreKind = 'oss' | 's3'

export type V2ObjectStoreConfig =
  | ({ readonly kind?: 'oss' } & OssConditionalObjectStoreV2Config)
  | ({ readonly kind: 's3' } & S3ConditionalObjectStoreV2Config)

export function v2ObjectStoreConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): V2ObjectStoreConfig {
  const kind = v2ObjectStoreKindFromEnv(env)

  if (kind === 's3') {
    return {
      kind,
      bucket: env.S3_BUCKET ?? 'databench',
      region: env.S3_REGION ?? 'us-east-1',
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      ...(env.S3_WORKER_ENDPOINT ? { workerEndpoint: env.S3_WORKER_ENDPOINT } : {}),
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }
        : {}),
      ...(env.S3_FORCE_PATH_STYLE !== undefined
        ? { forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false' }
        : {}),
    }
  }

  return {
    kind,
    bucket: env.OSS_BUCKET ?? 'databench',
    region: env.OSS_REGION ?? 'oss-cn-hangzhou',
    accessKeyId: env.OSS_ACCESS_KEY_ID ?? '',
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET ?? '',
    secure: env.OSS_SECURE !== 'false',
    internal: env.OSS_INTERNAL === 'true',
    ...(env.OSS_ENDPOINT ? { endpoint: env.OSS_ENDPOINT } : {}),
  }
}

function v2ObjectStoreKindFromEnv(env: NodeJS.ProcessEnv): V2ObjectStoreKind {
  const raw = (env.DATABENCH_OBJECT_STORE ?? 'oss').trim().toLowerCase()

  if (raw === 'oss' || raw === 's3') return raw

  throw new Error(`unsupported DATABENCH_OBJECT_STORE: ${env.DATABENCH_OBJECT_STORE}`)
}
