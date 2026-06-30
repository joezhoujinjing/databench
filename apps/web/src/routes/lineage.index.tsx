import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect } from 'react'
import { LineageExplorer } from './lineage.$ref.js'

export function LineageIndexPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { ref?: unknown }
  const ref = typeof search.ref === 'string' ? search.ref.trim() : ''

  useEffect(() => {
    if (ref !== '') {
      void navigate({ params: { ref }, replace: true, to: '/lineage/$ref' })
    }
  }, [navigate, ref])

  return <LineageExplorer initialRef={ref} />
}
