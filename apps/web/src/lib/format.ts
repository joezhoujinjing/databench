import type { DatasetManifest } from '@/api/types.js'

const NUMBER_FORMAT = new Intl.NumberFormat('en-US')
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
})

export function formatInteger(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? NUMBER_FORMAT.format(value) : '0'
}

export function formatCompactInteger(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? COMPACT_NUMBER_FORMAT.format(value)
    : '0'
}

export function shortRef(value: string, length = 12): string {
  if (value.length <= length) {
    return value
  }

  return value.slice(0, length)
}

export function ellipsizeMiddle(value: string, edge = 8): string {
  if (value.length <= edge * 2 + 3) {
    return value
  }

  return `${value.slice(0, edge)}...${value.slice(-edge)}`
}

export function kindEntries(manifest: Pick<DatasetManifest, 'kinds'>): [string, number][] {
  return Object.entries(manifest.kinds ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort(([left], [right]) => left.localeCompare(right))
}

export function kindCount(manifest: Pick<DatasetManifest, 'kinds'>, kind: string): number {
  const value = manifest.kinds?.[kind]
  return typeof value === 'number' ? value : 0
}

export function displayDatasetName(manifest: Pick<DatasetManifest, 'name' | 'version'>): string {
  return manifest.name ?? shortRef(manifest.version)
}
