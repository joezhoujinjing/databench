export const v2QueryKeys = {
  capability: (scope: string, base: string) => [scope, base, 'v2', 'capability'] as const,
  dataset: (scope: string, base: string, version: string) =>
    [scope, base, 'v2', 'dataset', version] as const,
  record: (scope: string, base: string, version: string, recordId: string) =>
    [scope, base, 'v2', 'dataset', version, 'record', recordId] as const,
  records: (scope: string, base: string, version: string, limit: number) =>
    [scope, base, 'v2', 'dataset', version, 'records', limit] as const,
  converters: (scope: string, base: string) => [scope, base, 'v2', 'converters'] as const,
  lineage: (scope: string, base: string, version: string, maxDepth: number, maxNodes: number) =>
    [scope, base, 'v2', 'lineage', version, maxDepth, maxNodes] as const,
  refsRoot: (scope: string, base: string) => [scope, base, 'v2', 'refs'] as const,
  deletedRefsRoot: (scope: string, base: string) => [scope, base, 'v2', 'deleted-refs'] as const,
  deletedRefs: (scope: string, base: string, limit: number) =>
    [scope, base, 'v2', 'deleted-refs', limit] as const,
  refs: (scope: string, base: string, limit: number) => [scope, base, 'v2', 'refs', limit] as const,
  resolution: (scope: string, base: string, ref: string) =>
    [scope, base, 'v2', 'resolution', ref] as const,
  transforms: (scope: string, base: string) => [scope, base, 'v2', 'transforms'] as const,
  transformJobsRoot: (scope: string, base: string) =>
    [scope, base, 'v2', 'transform-jobs'] as const,
  transformJobs: (scope: string, base: string, limit: number) =>
    [scope, base, 'v2', 'transform-jobs', 'list', limit] as const,
  transformJob: (scope: string, base: string, jobId: string) =>
    [scope, base, 'v2', 'transform-jobs', 'detail', jobId] as const,
} as const
