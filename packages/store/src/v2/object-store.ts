import type { V2ObjectStoreConfig } from './config.js'
import { type OssConditionalClientV2, OssConditionalObjectStoreV2 } from './oss-adapter.js'
import { S3ConditionalObjectStoreV2 } from './s3-adapter.js'
import type { WorkerStagingObjectStoreV1 } from './worker-staging.js'

/** Builds the canonical and Worker-staging capable adapter from one store config. */
export function createV2ObjectStore(config: V2ObjectStoreConfig): WorkerStagingObjectStoreV1 {
  if (config.kind === 's3') {
    return new S3ConditionalObjectStoreV2({
      bucket: config.bucket,
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.workerEndpoint === undefined ? {} : { workerEndpoint: config.workerEndpoint }),
      ...(config.accessKeyId === undefined ? {} : { accessKeyId: config.accessKeyId }),
      ...(config.secretAccessKey === undefined ? {} : { secretAccessKey: config.secretAccessKey }),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(config.client === undefined ? {} : { client: config.client }),
    })
  }

  const client =
    config.client === undefined ? undefined : requireOssConditionalClientV2(config.client)
  return new OssConditionalObjectStoreV2({
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    ...(config.region === undefined ? {} : { region: config.region }),
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.secure === undefined ? {} : { secure: config.secure }),
    ...(config.internal === undefined ? {} : { internal: config.internal }),
    ...(client === undefined ? {} : { client }),
  })
}

function requireOssConditionalClientV2(client: unknown): OssConditionalClientV2 {
  if (
    typeof client !== 'object' ||
    client === null ||
    !hasFunction(client, 'putStream') ||
    !hasFunction(client, 'get') ||
    !hasFunction(client, 'getObjectMeta') ||
    !hasFunction(client, 'getBucketInfo')
  ) {
    throw new TypeError(
      'Injected OSS client must implement the V2 conditional object-store methods',
    )
  }
  return client as OssConditionalClientV2
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'function'
}
