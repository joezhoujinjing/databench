import { type Capabilities, serviceCapabilities } from '@databench/schema'
import { listTransforms } from '@databench/workspace'

export function getCapabilities(): Capabilities {
  return serviceCapabilities({ transforms: listTransforms().length > 0 })
}
