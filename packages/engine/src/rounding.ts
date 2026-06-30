export function bankersRound(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot round non-finite value: ${value}`)
  }

  const floor = Math.floor(value)
  const fraction = value - floor

  if (fraction < 0.5) {
    return floor
  }

  if (fraction > 0.5) {
    return floor + 1
  }

  return floor % 2 === 0 ? floor : floor + 1
}
