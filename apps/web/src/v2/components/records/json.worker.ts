/// <reference lib="webworker" />

interface SerializeRequest {
  readonly previewMaxBytes: number
  readonly value: unknown
}

import { serializeJsonForDisplay } from './json-serialization.js'

const workerScope = self as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<SerializeRequest>) => {
  workerScope.postMessage(serializeJsonForDisplay(event.data.value, event.data.previewMaxBytes))
}
