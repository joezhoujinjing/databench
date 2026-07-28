import { describe, expect, test } from 'vitest'
import type { BenchmarkEntry, BenchmarksResponse } from '../api/schemas.js'
import {
  benchmarkCategoryCounts,
  benchmarkMarkdown,
  filterBenchmarks,
  flattenBenchmarks,
} from './benchmarks.js'

const item = (name: string, tags: string[]): BenchmarkEntry => ({
  category: 'llm',
  dataset_id: name,
  description: { en: { full: `# ${name}`, sections: {} } },
  few_shot_num: 0,
  meta: {},
  metrics: ['accuracy'],
  name,
  paper_url: null,
  pretty_name: name.toUpperCase(),
  subset_list: ['main'],
  tags,
  total_samples: 10,
})

describe('benchmark catalogue domain', () => {
  test('preserves all five category counts and multi-tag any-match filtering', () => {
    const response: BenchmarksResponse = {
      agent: [item('agent', ['tools'])],
      aigc: [item('aigc', ['image'])],
      multimodal: [item('vlm', ['image'])],
      text: [item('gsm8k', ['math', 'reasoning'])],
    }
    const benchmarks = flattenBenchmarks(response)
    expect(benchmarkCategoryCounts(benchmarks)).toEqual({
      agent: 1,
      aigc: 1,
      all: 4,
      multimodal: 1,
      text: 1,
    })
    expect(filterBenchmarks(benchmarks, 'all', '', ['math', 'image'])).toHaveLength(3)
    expect(filterBenchmarks(benchmarks, 'all', 'gsm8k', [])).toHaveLength(1)
    expect(benchmarkMarkdown(response.text?.[0] as BenchmarkEntry, 'en')).toBe('# gsm8k')
  })

  test('searches the description selected by the active locale', () => {
    const benchmark = {
      ...item('locale', []),
      description: {
        en: { full: 'English only phrase', sections: {} },
        zh: { full: '中文专属说明', sections: {} },
      },
      displayCategory: 'text' as const,
    }
    expect(filterBenchmarks([benchmark], 'all', '中文专属', [], 'zh')).toHaveLength(1)
    expect(filterBenchmarks([benchmark], 'all', '中文专属', [], 'en')).toHaveLength(0)
  })
})
