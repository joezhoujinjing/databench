import { isApiError } from './errors.js'

export function isNotDeployed(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 501)
}

export function retryOptionalFeature(failureCount: number, error: unknown): boolean {
  return !isNotDeployed(error) && failureCount < 1
}
