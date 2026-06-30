export const MAX_PAGE_LIMIT = 500
export const DEFAULT_PAGE_LIMIT = 20

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT
  }

  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
}
