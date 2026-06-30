import type { Capabilities } from './types.js'

export const CLIENT_VERSION = '0.1.0'
export const SUPPORTED_API_MAJORS = [1] as const

export type Compatibility =
  | { status: 'api_unsupported'; apiVersion: string }
  | { status: 'client_too_old'; currentClient: string; minClient: string }
  | { status: 'ok' }

export function checkCompatibility(capabilities: Capabilities | undefined): Compatibility {
  if (capabilities === undefined) {
    return { status: 'ok' }
  }

  const major = majorOf(capabilities.api_version)

  if (
    major === null ||
    !SUPPORTED_API_MAJORS.includes(major as (typeof SUPPORTED_API_MAJORS)[number])
  ) {
    return { status: 'api_unsupported', apiVersion: capabilities.api_version }
  }

  if (
    capabilities.min_client !== '' &&
    compareSemver(CLIENT_VERSION, capabilities.min_client) < 0
  ) {
    return {
      status: 'client_too_old',
      currentClient: CLIENT_VERSION,
      minClient: capabilities.min_client,
    }
  }

  return { status: 'ok' }
}

export function majorOf(version: string): number | null {
  const normalized = version.trim().replace(/^v/u, '')
  const [major] = normalized.split('.')

  if (major === undefined || !/^\d+$/u.test(major)) {
    return null
  }

  return Number.parseInt(major, 10)
}

export function compareSemver(left: string, right: string): number {
  const leftParts = semverParts(left)
  const rightParts = semverParts(right)
  const width = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < width; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)

    if (difference !== 0) {
      return Math.sign(difference)
    }
  }

  return 0
}

function semverParts(version: string): number[] {
  return version.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
}
