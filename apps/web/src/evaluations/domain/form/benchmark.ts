export function benchmarkSuggestions(
  value: string,
  benchmarkNames: readonly string[],
  limit = 8,
): readonly string[] {
  const current = value.trim().toLocaleLowerCase()
  if (current === '') return []
  return benchmarkNames.filter((name) => name.toLocaleLowerCase().includes(current)).slice(0, limit)
}

export function replaceLastBenchmark(_value: string, benchmark: string): string {
  return benchmark
}
