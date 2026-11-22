'use client'

import { ENERGY_EQUIVALENTS, nearestEquivalent } from '@/lib/energy/equivalencies'
import { formatKwh } from '@/lib/energy/format'

interface EnergyEquivalenceProps {
  /** The energy consumed, in kWh. */
  readonly kwh: number
}

/**
 * A sentence putting an energy figure in real-world terms, with a hover (or
 * keyboard focus) popover listing every reference activity.
 */
export function EnergyEquivalence({ kwh }: EnergyEquivalenceProps) {
  const equivalent = nearestEquivalent(kwh)

  if (equivalent === null) {
    return null
  }

  return (
    <div className="group relative mt-1 text-xs leading-5">
      <span
        tabIndex={0}
        className="cursor-help italic text-emerald-700 underline decoration-emerald-300 decoration-dotted underline-offset-2"
      >
        equivalent to {equivalent.label}
      </span>
      <div
        role="tooltip"
        className="invisible absolute left-0 top-full z-20 mt-2 w-72 rounded-md border border-zinc-200 bg-white p-3 opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <p className="text-xs font-semibold text-zinc-900">Electricity use equivalents</p>
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {ENERGY_EQUIVALENTS.map(entry => (
            <li key={entry.label} className="flex items-baseline justify-between gap-3">
              <span className={entry === equivalent ? 'font-medium text-emerald-700' : 'text-zinc-600'}>
                {entry.label}
              </span>
              <span className="flex-none text-zinc-500">{formatKwh(entry.kwh)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
