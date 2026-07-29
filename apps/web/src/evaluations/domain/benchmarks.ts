import type { BenchmarkEntry, BenchmarksResponse } from '../api/schemas.js'

export type BenchmarkCategory = 'agent' | 'aigc' | 'all' | 'multimodal' | 'text'
export type CategorizedBenchmark = BenchmarkEntry & {
  readonly displayCategory: Exclude<BenchmarkCategory, 'all'>
}

const CATEGORY_KEYS = ['text', 'multimodal', 'agent', 'aigc'] as const

export function flattenBenchmarks(response: BenchmarksResponse): CategorizedBenchmark[] {
  return CATEGORY_KEYS.flatMap((category) =>
    (response[category] ?? []).map((benchmark) => ({ ...benchmark, displayCategory: category })),
  )
}

export function benchmarkCategoryCounts(
  benchmarks: readonly CategorizedBenchmark[],
): Record<BenchmarkCategory, number> {
  return {
    agent: benchmarks.filter((benchmark) => benchmark.displayCategory === 'agent').length,
    aigc: benchmarks.filter((benchmark) => benchmark.displayCategory === 'aigc').length,
    all: benchmarks.length,
    multimodal: benchmarks.filter((benchmark) => benchmark.displayCategory === 'multimodal').length,
    text: benchmarks.filter((benchmark) => benchmark.displayCategory === 'text').length,
  }
}

export function filterBenchmarks(
  benchmarks: readonly CategorizedBenchmark[],
  category: BenchmarkCategory,
  search: string,
  tags: readonly string[],
  language = 'en',
): CategorizedBenchmark[] {
  const query = search.trim().toLocaleLowerCase()
  return benchmarks.filter((benchmark) => {
    if (category !== 'all' && benchmark.displayCategory !== category) return false
    if (tags.length > 0 && !tags.some((tag) => benchmark.tags.includes(tag))) return false
    if (!query) return true
    return [
      benchmark.name,
      benchmark.pretty_name,
      benchmarkMarkdown(benchmark, language),
      ...benchmark.tags,
    ].some((value) => value.toLocaleLowerCase().includes(query))
  })
}

export function benchmarkMarkdown(benchmark: BenchmarkEntry, language: string): string {
  const preferred = language.toLocaleLowerCase().startsWith('zh') ? 'zh' : 'en'
  const description =
    benchmark.description[preferred] ?? benchmark.description.en ?? benchmark.description.zh
  if (!description) return ''
  if (description.full.trim()) return description.full
  return Object.values(description.sections).filter(Boolean).join('\n\n')
}
