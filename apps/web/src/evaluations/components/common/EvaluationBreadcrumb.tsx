import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

export interface EvaluationBreadcrumbItem {
  readonly label: string
  readonly to?: '/evaluations' | '/evaluations/performance' | '/evaluations/reports'
}

export function EvaluationBreadcrumb({
  items,
  label,
}: {
  readonly items: readonly EvaluationBreadcrumbItem[]
  readonly label: string
}) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-wrap items-center gap-1 text-muted-foreground text-sm">
        {items.map((item, index) => (
          <li className="flex items-center gap-1" key={`${item.to ?? 'current'}:${item.label}`}>
            {index > 0 ? <ChevronRight aria-hidden="true" size={13} /> : null}
            {item.to === undefined ? (
              <span aria-current="page" className="text-foreground">
                {item.label}
              </span>
            ) : (
              <Link className="hover:text-foreground" to={item.to}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
