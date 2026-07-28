import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const evaluationsRoot = path.resolve(import.meta.dirname)
const webSourceRoot = path.resolve(import.meta.dirname, '..')

describe('Evaluation UI foundation static boundaries', () => {
  test('contains no second router, theme context, locale context, or bare provider API path', async () => {
    const files = await sourceFiles(evaluationsRoot)
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    const joined = sources.join('\n')

    expect(joined).not.toContain('react-router-dom')
    expect(joined).not.toContain('BrowserRouter')
    expect(joined).not.toContain('ThemeContext')
    expect(joined).not.toContain('LocaleContext')
    expect(joined).not.toMatch(/['"]\/api\/v1/u)
  })

  test('keeps EvalScope tokens scoped and registers every route lazily', async () => {
    const css = await readFile(path.join(evaluationsRoot, 'styles/tokens.css'), 'utf8')
    const router = await readFile(path.join(webSourceRoot, 'router.tsx'), 'utf8')

    expect(css).toContain('.evaluation-surface')
    expect(css).not.toMatch(/(^|\n)\s*:root\b/u)
    for (const token of ['--es-bg', '--es-card', '--es-text', '--es-accent', '--es-danger']) {
      expect(css).toContain(token)
    }
    for (const route of [
      '/evaluations',
      'tasks',
      'reports',
      'reports/$reportKey',
      'compare',
      'performance',
      'performance/$performanceKey',
      'performance/compare',
      'benchmarks',
      'viewer',
    ]) {
      expect(router).toContain(`path: '${route}'`)
    }
    expect(router.match(/lazyRouteComponent\(/gu)).toHaveLength(11)
  })
})

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name)
      if (entry.isDirectory()) return sourceFiles(target)
      if (
        !entry.isFile() ||
        !/\.(?:css|ts|tsx)$/u.test(entry.name) ||
        entry.name.endsWith('.test.ts')
      ) {
        return []
      }
      return [target]
    }),
  )
  return nested.flat()
}
