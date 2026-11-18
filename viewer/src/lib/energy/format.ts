export const JOULES_PER_KWH = 3_600_000

export function formatSignificant(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(value)
}

export function formatKwh(kwh: number): string {
  return `${formatSignificant(kwh)} kWh`
}

export function formatJoules(kwh: number): string {
  const joules = kwh * JOULES_PER_KWH
  if (joules >= 1e9) return `${formatSignificant(joules / 1e9)} GJ`
  if (joules >= 1e6) return `${formatSignificant(joules / 1e6)} MJ`
  if (joules >= 1e3) return `${formatSignificant(joules / 1e3)} kJ`
  return `${formatSignificant(joules)} J`
}

export function formatCarbon(carbonG: number | null): string {
  if (carbonG === null) {
    return '—'
  }
  return carbonG >= 1000
    ? `${formatSignificant(carbonG / 1000)} kg CO₂e`
    : `${formatSignificant(carbonG)} g CO₂e`
}
