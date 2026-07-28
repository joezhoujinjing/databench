import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button.js'
import type { GeneratedDocumentDescriptor } from '../api/schemas.js'
import { taskViewerHref } from '../hooks/use-task-runner.js'

export function SafeReportLink({
  children,
  document,
}: {
  readonly children: ReactNode
  readonly document: GeneratedDocumentDescriptor
}) {
  return (
    <Button asChild size="sm">
      <a href={taskViewerHref(document)} rel="noopener noreferrer" target="_blank">
        <ExternalLink aria-hidden="true" size={14} />
        {children}
      </a>
    </Button>
  )
}
