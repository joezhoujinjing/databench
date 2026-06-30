import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useMemo } from 'react'
import { useBackend } from './backend.js'
import {
  createDataset,
  getDataset,
  getSamples,
  ingestJsonl,
  nextSamplePageParam,
} from './datasets.js'
import { getLineage } from './lineage.js'
import { getHealth } from './meta.js'
import { clampLimit } from './pagination.js'
import { retryOptionalFeature } from './query-policies.js'
import { materializeRecipe } from './recipes.js'
import { listRefs, resolveRef } from './refs.js'
import { listTransforms, runTransform } from './transforms.js'
import type { DatasetManifest } from './types.js'
import {
  deriveVocabulary,
  getVocabulary,
  listVocabularies,
  normalizeVocabulary,
  saveVocabulary,
  validateVocabulary,
} from './vocabularies.js'

export const queryKeys = {
  capabilities: (base: string) => [base, 'capabilities'] as const,
  dataset: (base: string, ref: string) => [base, 'dataset', ref] as const,
  health: (base: string) => [base, 'health'] as const,
  lineage: (base: string, ref: string) => [base, 'lineage', ref] as const,
  refs: (base: string, limit?: number) =>
    limit === undefined ? ([base, 'refs'] as const) : ([base, 'refs', limit] as const),
  samples: (base: string, ref: string, limit: number, offset: number) =>
    [base, 'samples', ref, limit, offset] as const,
  samplesInfinite: (base: string, ref: string, limit: number) =>
    [base, 'samples', ref, limit, 'infinite'] as const,
  transforms: (base: string, limit?: number) =>
    limit === undefined ? ([base, 'transforms'] as const) : ([base, 'transforms', limit] as const),
  version: (base: string) => [base, 'version'] as const,
  vocabularies: (base: string, limit?: number) =>
    limit === undefined
      ? ([base, 'vocabularies'] as const)
      : ([base, 'vocabularies', limit] as const),
  vocabulary: (base: string, name: string) => [base, 'vocabulary', name] as const,
} as const

export function useHealth() {
  const { base, token } = useBackend()

  return useQuery({
    queryFn: () => getHealth({ base, token }),
    queryKey: queryKeys.health(base),
    refetchInterval: 15_000,
    retry: false,
  })
}

export function useDataset(ref: string) {
  const { base, token } = useBackend()

  return useQuery({
    enabled: ref.trim() !== '',
    queryFn: () => getDataset({ base, ref, token }),
    queryKey: queryKeys.dataset(base, ref),
  })
}

export function useDatasets(refs: readonly string[]): ReadonlyMap<string, DatasetManifest> {
  const { base, token } = useBackend()
  const uniqueRefs = useMemo(
    () => [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))],
    [refs],
  )

  return useQueries({
    combine: (results) =>
      new Map(
        results
          .map((result, index) => [uniqueRefs[index], result.data] as const)
          .filter(
            (entry): entry is readonly [string, DatasetManifest] =>
              entry[0] !== undefined && entry[1] !== undefined,
          ),
      ),
    queries: uniqueRefs.map((ref) => ({
      queryFn: () => getDataset({ base, ref, token }),
      queryKey: queryKeys.dataset(base, ref),
    })),
  })
}

export function useRefs(limit = 200) {
  const { base, token } = useBackend()
  const clampedLimit = clampLimit(limit)

  return useQuery({
    queryFn: () => listRefs({ base, limit: clampedLimit, token }),
    queryKey: queryKeys.refs(base, clampedLimit),
  })
}

export function useResolveRef(name: string) {
  const { base, token } = useBackend()

  return useQuery({
    enabled: name.trim() !== '',
    queryFn: () => resolveRef({ base, name, token }),
    queryKey: [base, 'ref', name] as const,
  })
}

export function useSamples(ref: string, limit: number, offset: number) {
  const { base, token } = useBackend()
  const clampedLimit = clampLimit(limit)

  return useQuery({
    enabled: ref.trim() !== '',
    placeholderData: keepPreviousData,
    queryFn: () => getSamples({ base, limit: clampedLimit, offset, ref, token }),
    queryKey: queryKeys.samples(base, ref, clampedLimit, offset),
  })
}

export function useInfiniteSamples(ref: string, limit: number) {
  const { base, token } = useBackend()
  const clampedLimit = clampLimit(limit)

  return useInfiniteQuery({
    enabled: ref.trim() !== '',
    getNextPageParam: nextSamplePageParam,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getSamples({
        base,
        limit: clampedLimit,
        offset: Number(pageParam),
        ref,
        token,
      }),
    queryKey: queryKeys.samplesInfinite(base, ref, clampedLimit),
  })
}

export function useCreateDataset() {
  const { base, token } = useBackend()
  const invalidateRefs = useRefsInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof createDataset>[0], 'base' | 'token'>) =>
      createDataset({ ...variables, base, token }),
    onSuccess: invalidateRefs,
  })
}

export function useIngestJsonl() {
  const { base, token } = useBackend()
  const invalidateRefs = useRefsInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof ingestJsonl>[0], 'base' | 'token'>) =>
      ingestJsonl({ ...variables, base, token }),
    onSuccess: invalidateRefs,
  })
}

export function useTransforms(limit = 500) {
  const { base, token } = useBackend()
  const clampedLimit = clampLimit(limit)

  return useQuery({
    queryFn: () => listTransforms({ base, limit: clampedLimit, token }),
    queryKey: queryKeys.transforms(base, clampedLimit),
    retry: retryOptionalFeature,
  })
}

export function useRunTransform() {
  const { base, token } = useBackend()
  const invalidateRefs = useRefsInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof runTransform>[0], 'base' | 'token'>) =>
      runTransform({ ...variables, base, token }),
    onSuccess: invalidateRefs,
  })
}

export function useMaterializeRecipe() {
  const { base, token } = useBackend()
  const invalidateRefs = useRefsInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof materializeRecipe>[0], 'base' | 'token'>) =>
      materializeRecipe({ ...variables, base, token }),
    onSuccess: invalidateRefs,
  })
}

export function useLineage(ref: string) {
  const { base, token } = useBackend()

  return useQuery({
    enabled: ref.trim() !== '',
    queryFn: () => getLineage({ base, ref, token }),
    queryKey: queryKeys.lineage(base, ref),
    retry: retryOptionalFeature,
  })
}

export function useVocabularies(limit = 500) {
  const { base, token } = useBackend()
  const clampedLimit = clampLimit(limit)

  return useQuery({
    queryFn: () => listVocabularies({ base, limit: clampedLimit, token }),
    queryKey: queryKeys.vocabularies(base, clampedLimit),
    retry: retryOptionalFeature,
  })
}

export function useVocabulary(name: string) {
  const { base, token } = useBackend()

  return useQuery({
    enabled: name.trim() !== '',
    queryFn: () => getVocabulary({ base, name, token }),
    queryKey: queryKeys.vocabulary(base, name),
    retry: retryOptionalFeature,
  })
}

export function useDeriveVocabulary() {
  const { base, token } = useBackend()
  const invalidateVocabularies = useVocabulariesInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof deriveVocabulary>[0], 'base' | 'token'>) =>
      deriveVocabulary({ ...variables, base, token }),
    onSuccess: invalidateVocabularies,
  })
}

export function useSaveVocabulary() {
  const { base, token } = useBackend()
  const queryClient = useQueryClient()
  const invalidateVocabularies = useVocabulariesInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof saveVocabulary>[0], 'base' | 'token'>) =>
      saveVocabulary({ ...variables, base, token }),
    onSuccess: (_data, variables) => {
      invalidateVocabularies()
      void queryClient.invalidateQueries({ queryKey: queryKeys.vocabulary(base, variables.name) })
    },
  })
}

export function useNormalizeVocabulary() {
  const { base, token } = useBackend()
  const invalidateRefs = useRefsInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof normalizeVocabulary>[0], 'base' | 'token'>) =>
      normalizeVocabulary({ ...variables, base, token }),
    onSuccess: invalidateRefs,
  })
}

export function useValidateVocabulary() {
  const { base, token } = useBackend()
  const invalidateRefs = useRefsInvalidation(base)

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof validateVocabulary>[0], 'base' | 'token'>) =>
      validateVocabulary({ ...variables, base, token }),
    onSuccess: invalidateRefs,
  })
}

function useRefsInvalidation(base: string): () => void {
  const queryClient = useQueryClient()

  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.refs(base) })
  }
}

function useVocabulariesInvalidation(base: string): () => void {
  const queryClient = useQueryClient()

  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.vocabularies(base) })
  }
}
