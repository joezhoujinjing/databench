import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Report the monorepo root version, matching apps/api's /version. This file lives
// directly under src/ (depth 3 from root) so the relative path resolves the same
// whether run bundled (dist/index.js) or via tsx (src/**).
export function readServiceVersion(): string {
  const url = new URL('../../../package.json', import.meta.url)
  const parsed = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { version?: string }
  return parsed.version ?? '0.0.0'
}
