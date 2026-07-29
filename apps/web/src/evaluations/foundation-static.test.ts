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
    expect(joined).not.toMatch(/window\.open\(/u)
    expect(joined).not.toMatch(/target=["']_blank["'][^>]*href=.*generated-documents/u)
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

  test('keeps all five evaluation entries in the responsive workspace sidebar', async () => {
    const [layout, root] = await Promise.all([
      readFile(path.join(evaluationsRoot, 'layouts/EvaluationLayout.tsx'), 'utf8'),
      readFile(path.join(webSourceRoot, 'routes/__root.tsx'), 'utf8'),
    ])

    for (const route of [
      '/evaluations',
      '/evaluations/reports',
      '/evaluations/performance',
      '/evaluations/tasks',
      '/evaluations/benchmarks',
    ]) {
      expect(layout).toContain(`to: '${route}'`)
    }
    expect(layout).toContain('grid-cols-[13.5rem_minmax(0,1fr)]')
    expect(layout).toContain('max-lg:flex-row')
    expect(layout).toContain('evaluation-sidebar-active')
    expect(layout).toContain('includeSearch: false')
    expect(root).toContain("pathname.startsWith('/evaluations')")
  })

  test('uses the path-free configured-source refresh control on reports', async () => {
    const refresh = await readFile(
      path.join(evaluationsRoot, 'components/ConfiguredSourceRefresh.tsx'),
      'utf8',
    )
    const reports = await readFile(
      path.join(evaluationsRoot, 'features/reports/ReportsPage.tsx'),
      'utf8',
    )

    expect(reports).toContain('<ConfiguredSourceRefresh')
    expect(refresh).toContain('onRefresh')
    expect(refresh).not.toMatch(/root[_A-Z-]?path/iu)
    expect(refresh).not.toContain('type="text"')
  })

  test('opens generated reports only in the product viewer sandbox', async () => {
    const safeLink = await readFile(
      path.join(evaluationsRoot, 'components/SafeReportLink.tsx'),
      'utf8',
    )
    const taskRunner = await readFile(
      path.join(evaluationsRoot, 'hooks/use-task-runner.ts'),
      'utf8',
    )
    const viewer = await readFile(path.join(evaluationsRoot, 'routes/viewer.tsx'), 'utf8')
    const generatedFrame = await readFile(
      path.join(evaluationsRoot, 'components/SafeGeneratedDocumentFrame.tsx'),
      'utf8',
    )

    expect(taskRunner).toContain('/evaluations/viewer?')
    expect(safeLink).toContain('noopener noreferrer')
    expect(viewer).toContain('sandbox="allow-scripts"')
    expect(viewer).not.toContain('allow-same-origin')
    expect(generatedFrame).toContain('sandbox="allow-scripts"')
    expect(generatedFrame).not.toContain('allow-same-origin')
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
