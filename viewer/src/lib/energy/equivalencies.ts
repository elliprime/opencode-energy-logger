/**
 * Real-world activities whose energy use is roughly equivalent to a given
 * amount of consumed electricity, used to put the viewer's totals in context.
 */

export interface EnergyEquivalent {
  readonly kwh: number
  readonly label: string
}

export const ENERGY_EQUIVALENTS: readonly EnergyEquivalent[] = [
  {
    // Source: https://wattcosts.com/blog/cost-to-charge-a-phone/
    kwh: 0.019,
    label: 'one full charge of a smartphone',
  },
  {
    // Source: https://wattcosts.com/blog/cost-to-charge-a-phone/
    kwh: 0.07,
    label: 'one full charge of a laptop',
  },
  {
    // Source: https://wattcosts.com/cost-to-run/microwave/
    kwh: 0.17,
    label: 'running a microwave for 10 minutes',
  },
  {
    // Average of 342 washing machines on the UK market: 0.417 kWh per cycle
    // (official Eco 40-60 label figures; most machines fall in 0.3-0.55).
    // Source: https://www.siliconvalleypower.com/residents/save-energy/appliance-energy-use-chart
    kwh: 0.5,
    label: 'one washing machine cycle',
  },
  {
    // A normal dishwasher cycle uses 1-2.17 kWh per load.
    // Source: https://www.siliconvalleypower.com/residents/save-energy/appliance-energy-use-chart
    kwh: 1.1,
    label: 'one dishwasher cycle',
  },
  {
    // Source: https://www.siliconvalleypower.com/residents/save-energy/appliance-energy-use-chart
    kwh: 1.5,
    label: 'running a fridge for a day',
  },
  {
    // Source: https://www.siliconvalleypower.com/residents/save-energy/appliance-energy-use-chart
    kwh: 2.3,
    label: 'running an electric oven for an hour',
  },
  {
    // Median 10,000-14,000 BTU window AC: 750 W × 6 hours = 4.5 kWh.
    // Source: https://onepublicgrid.com/cost-to-run?list=space-heater%2Cwindow-ac
    kwh: 4.5,
    label: 'running a window air conditioner for 6 hours',
  },
  {
    // A central AC averaging 2,500 W for 8 hours a day uses ~20 kWh.
    // Source: https://lowcarbonlife.org/how-much-electricity-does-an-air-conditioner-use
    kwh: 20,
    label: 'running a central air conditioner for a day',
  },
  {
    // EPA-rated at 24 kWh/100 miles
    // Source: https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=50038
    kwh: 25,
    label: 'driving an electric car 100 miles',
  },
  {
    // The average US household consumes ~10,500 kWh/year ≈ 29 kWh/day.
    // Source: https://en.wikipedia.org/wiki/Domestic_energy_consumption
    kwh: 30,
    label: "a US home's electricity for a day",
  },
  {
    // A standard 1,500 W space heater running nonstop for 24 hours uses 36 kWh.
    // Source: https://heatingcostcalculator.com/1500-watt-heater-cost
    kwh: 36,
    label: 'running a space heater nonstop for a day',
  },
  {
    // Source: https://www.siliconvalleypower.com/residents/save-energy/appliance-energy-use-chart
    kwh: 45,
    label: 'running a fridge for a month',
  },
  {
    // The Kia EV9 Long Range's battery pack holds 99.8 kWh.
    // Source: https://kiamedia.com/us/en/models/ev9/2026/specifications
    kwh: 100,
    label: 'one full charge of a long-range electric car',
  },
]

export function nearestEquivalent(kwh: number): EnergyEquivalent | null {
  if (kwh <= 0) {
    return null
  }

  return ENERGY_EQUIVALENTS.reduce((best, entry) =>
    Math.abs(Math.log(kwh / entry.kwh)) < Math.abs(Math.log(kwh / best.kwh)) ? entry : best,
  )
}
