const NUMBER_FORMAT = new Intl.NumberFormat('en-US')

export function formatInteger(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? NUMBER_FORMAT.format(value) : '0'
}

export function ellipsizeMiddle(value: string, edge = 8): string {
  if (value.length <= edge * 2 + 3) return value
  return `${value.slice(0, edge)}...${value.slice(-edge)}`
}
