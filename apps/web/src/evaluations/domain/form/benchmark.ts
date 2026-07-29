export function benchmarkSuggestions(
  value: string,
  benchmarkNames: readonly string[],
  limit = 8,
): readonly string[] {
  const current = value.split(',').at(-1)?.trim().toLocaleLowerCase() ?? ''
  if (current === '') return []
  return benchmarkNames.filter((name) => name.toLocaleLowerCase().includes(current)).slice(0, limit)
}

export function replaceLastBenchmark(value: string, benchmark: string): string {
  const parts = value.split(',').map((part) => part.trim())
  parts[parts.length - 1] = benchmark
  return parts.filter(Boolean).join(', ')
}
