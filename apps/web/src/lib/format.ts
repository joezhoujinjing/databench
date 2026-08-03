const NUMBER_FORMAT = new Intl.NumberFormat('en-US')

export function formatInteger(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? NUMBER_FORMAT.format(value) : '0'
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value

  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

export function ellipsizeMiddle(value: string, edge = 8): string {
  if (value.length <= edge * 2 + 3) return value
  return `${value.slice(0, edge)}...${value.slice(-edge)}`
}
