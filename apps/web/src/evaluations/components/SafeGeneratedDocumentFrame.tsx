import { evalScopeClient } from '../api/client.js'
import type { GeneratedDocumentDescriptor } from '../api/schemas.js'

export function SafeGeneratedDocumentFrame({
  className = 'min-h-[32rem] w-full rounded-[5px] border border-border bg-white',
  document,
  title,
}: {
  readonly className?: string
  readonly document: GeneratedDocumentDescriptor
  readonly title: string
}) {
  return (
    <iframe
      className={className}
      sandbox="allow-scripts"
      src={evalScopeClient.generatedDocumentUrl(document)}
      title={title}
    />
  )
}
