import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBackend } from '@/api/backend.js'
import { ApiError } from '@/api/errors.js'
import { checkCompatibility } from '@/api/version.js'
import { classifyPostTrainingV2 } from './capability.js'
import {
  auditDatasetV2,
  describeDatasetV2,
  getCapabilitiesV2,
  getDatasetRecordV2,
  getLineageV2,
  ingestCanonicalDatasetV2,
  inspectExportV2,
  listConvertersV2,
  listDatasetRecordsV2,
  listRefsV2,
  listTransformsV2,
  putRefV2,
  runTransformV2,
} from './client.js'
import { v2QueryKeys } from './query-keys.js'
import type { DatasetLineageV2, RecordPageV2, RefPageV2 } from './types.js'

const IMMUTABLE_QUERY = {
  gcTime: 30 * 60 * 1000,
  staleTime: Number.POSITIVE_INFINITY,
} as const

export function usePostTrainingV2State() {
  const { base, connectionScope, token } = useBackend()
  const query = useQuery({
    queryFn: ({ signal }) => getCapabilitiesV2({ base, signal, token }),
    queryKey: v2QueryKeys.capability(connectionScope, base),
    refetchInterval: 30_000,
    retry: false,
  })

  return classifyPostTrainingV2({
    capabilities: query.data,
    compatibility: checkCompatibility(query.data),
    error: query.error,
    isError: query.isError,
    isLoading: query.isLoading,
  })
}

export function useV2Refs(limit = 100) {
  const { base, connectionScope, token } = useBackend()

  return useInfiniteQuery({
    getNextPageParam: nextRefCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      listRefsV2({ base, cursor: pageParam, limit, signal, token }),
    queryKey: v2QueryKeys.refs(connectionScope, base, limit),
  })
}

export function useV2DatasetResolution(ref: string) {
  const { base, connectionScope, token } = useBackend()

  return useQuery({
    enabled: ref.trim() !== '',
    queryFn: ({ signal }) => describeDatasetV2({ base, refOrVersion: ref, signal, token }),
    queryKey: v2QueryKeys.resolution(connectionScope, base, ref),
    refetchInterval: 30_000,
  })
}

export function useV2Dataset(version: string) {
  const { base, connectionScope, token } = useBackend()

  return useQuery({
    ...IMMUTABLE_QUERY,
    enabled: version.trim() !== '',
    queryFn: async ({ signal }) => {
      const view = await describeDatasetV2({ base, refOrVersion: version, signal, token })
      if (view.dataset_version !== version) {
        throw new ApiError({
          code: 'integrity_error',
          message: 'The dataset view does not match the requested immutable version.',
          status: 500,
        })
      }
      return view
    },
    queryKey: v2QueryKeys.dataset(connectionScope, base, version),
  })
}

export function useV2Records(version: string, limit = 100) {
  const { base, connectionScope, token } = useBackend()

  return useInfiniteQuery({
    ...IMMUTABLE_QUERY,
    enabled: version.trim() !== '',
    getNextPageParam: nextRecordOffset,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      listDatasetRecordsV2({
        base,
        limit,
        offset: pageParam,
        refOrVersion: version,
        signal,
        token,
      }),
    queryKey: v2QueryKeys.records(connectionScope, base, version, limit),
  })
}

export function useV2Record(version: string, recordId: string) {
  const { base, connectionScope, token } = useBackend()

  return useQuery({
    ...IMMUTABLE_QUERY,
    enabled: version.trim() !== '' && recordId.trim() !== '',
    queryFn: ({ signal }) =>
      getDatasetRecordV2({ base, recordId, refOrVersion: version, signal, token }),
    queryKey: v2QueryKeys.record(connectionScope, base, version, recordId),
  })
}

export function useV2Audit(refOrVersion: string) {
  const { base, token } = useBackend()

  return useMutation({
    mutationFn: (signal?: AbortSignal) =>
      auditDatasetV2({
        base,
        refOrVersion,
        token,
        ...(signal === undefined ? {} : { signal }),
      }),
  })
}

export function useV2Ingest() {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (
      variables: Omit<Parameters<typeof ingestCanonicalDatasetV2>[0], 'base' | 'token'>,
    ) => ingestCanonicalDatasetV2({ ...variables, base, token }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: v2QueryKeys.refsRoot(connectionScope, base) })
      if (result.ref_update.status === 'updated') {
        await queryClient.invalidateQueries({
          queryKey: v2QueryKeys.resolution(connectionScope, base, result.ref_update.ref_name),
        })
      }
    },
  })
}

export function useV2Transforms() {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    queryFn: ({ signal }) => listTransformsV2({ base, signal, token }),
    queryKey: v2QueryKeys.transforms(connectionScope, base),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useV2RunTransform() {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof runTransformV2>[0], 'base' | 'token'>) =>
      runTransformV2({ ...variables, base, token }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: v2QueryKeys.refsRoot(connectionScope, base) })
      if (result.ref_update.status === 'updated') {
        await queryClient.invalidateQueries({
          queryKey: v2QueryKeys.resolution(connectionScope, base, result.ref_update.ref_name),
        })
      }
    },
  })
}

export function useV2PutRef() {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof putRefV2>[0], 'base' | 'token'>) =>
      putRefV2({ ...variables, base, token }),
    onSuccess: async (ref) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: v2QueryKeys.refsRoot(connectionScope, base) }),
        queryClient.invalidateQueries({
          queryKey: v2QueryKeys.resolution(connectionScope, base, ref.name),
        }),
      ])
    },
  })
}

export function useV2Lineage(version: string, maxDepth = 8, maxNodes = 100) {
  const { base, connectionScope, token } = useBackend()
  return useInfiniteQuery({
    ...IMMUTABLE_QUERY,
    enabled: version.trim() !== '',
    getNextPageParam: nextLineageCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      getLineageV2({
        base,
        cursor: pageParam,
        maxDepth,
        maxNodes,
        refOrVersion: version,
        signal,
        token,
      }),
    queryKey: v2QueryKeys.lineage(connectionScope, base, version, maxDepth, maxNodes),
  })
}

export function useV2Converters() {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    queryFn: ({ signal }) => listConvertersV2({ base, signal, token }),
    queryKey: v2QueryKeys.converters(connectionScope, base),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useV2InspectExport() {
  const { base, token } = useBackend()
  return useMutation({
    mutationFn: (variables: Omit<Parameters<typeof inspectExportV2>[0], 'base' | 'token'>) =>
      inspectExportV2({ ...variables, base, token }),
  })
}

export function nextRefCursor(
  lastPage: RefPageV2,
  pages: readonly RefPageV2[],
): string | undefined {
  const cursor = lastPage.next_cursor
  if (cursor === null) return undefined

  const alreadySeen = pages.slice(0, -1).some((page) => page.next_cursor === cursor)
  return alreadySeen ? undefined : cursor
}

export function nextRecordOffset(lastPage: RecordPageV2): number | undefined {
  if (lastPage.items.length === 0) return undefined
  const next = lastPage.offset + lastPage.items.length
  return next < lastPage.total ? next : undefined
}

export function nextLineageCursor(
  lastPage: DatasetLineageV2,
  pages: readonly DatasetLineageV2[],
): string | undefined {
  const cursor = lastPage.next_cursor
  if (cursor === null) return undefined
  return pages.slice(0, -1).some((page) => page.next_cursor === cursor) ? undefined : cursor
}
