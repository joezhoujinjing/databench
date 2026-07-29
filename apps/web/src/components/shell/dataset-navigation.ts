export type DatasetNavigationSection = 'datasets' | 'ingest' | 'transforms'

export function datasetNavigationSection(pathname: string): DatasetNavigationSection | null {
  if (pathname === '/ingest') return 'ingest'
  if (pathname === '/transforms') return 'transforms'

  if (
    pathname === '/datasets' ||
    pathname.startsWith('/datasets/') ||
    pathname.startsWith('/lineage/') ||
    pathname.startsWith('/export/')
  ) {
    return 'datasets'
  }

  return null
}
