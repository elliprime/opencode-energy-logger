'use client'

import { useEffect, useState, type ReactNode } from 'react'
import {
  computeDashboardStats,
  type DashboardStats,
  type EnergyFilter,
  type GroupEnergy,
  type PromptLocation,
} from '@/lib/energy/stats'
import {
  JOULES_PER_KWH,
  formatCarbon,
  formatJoules,
  formatKwh,
  formatSignificant,
} from '@/lib/energy/format'
import { PromptChronology } from '@/components/prompt-chronology'
import { TopPrompts } from '@/components/top-prompts'
import { EnergyEquivalence } from '@/components/energy-equivalence'

interface EnergyDashboardProps {
  /** The filter restricting which records the dashboard's metrics use. */
  readonly filter: EnergyFilter

  readonly annotationSyncCount: number
}

export function EnergyDashboard({ filter, annotationSyncCount }: EnergyDashboardProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [promptFocus, setPromptFocus] = useState<PromptLocation | null>(null)
  const [chronologySession, setChronologySession] = useState('')

  function focusPrompt(focus: PromptLocation): void {
    setPromptFocus(focus)
    setChronologySession(focus.sessionId)
  }

  useEffect(() => {
    let cancelled = false
    computeDashboardStats(filter)
      .then(result => {
        if (!cancelled) {
          setStats(result)
        }
      })
      .catch(caught => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Something went wrong')
        }
      })

    return () => {
      cancelled = true
    }
  }, [filter, annotationSyncCount])

  if (error !== null) {
    return (
      <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-base text-red-800">
        {error}
      </p>
    )
  }

  if (stats === null) {
    return <p className="text-base text-zinc-500">Computing the dashboard…</p>
  }

  const { totals, byModel, byAgent } = stats
  const avgPowerWatts =
    totals.totalDurationSeconds !== null && totals.totalDurationSeconds > 0
      ? (totals.totalKwh * JOULES_PER_KWH) / totals.totalDurationSeconds
      : null

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="Total energy"
          value={formatKwh(totals.totalKwh)}
          detail={formatJoules(totals.totalKwh)}
          footer={<EnergyEquivalence kwh={totals.totalKwh} />}
        />
        <StatCard
          label="Carbon footprint"
          value={formatCarbon(totals.totalCarbonG)}
          detail={
            totals.totalCarbonG !== null && totals.totalKwh > 0
              ? `≈ ${formatSignificant(totals.totalCarbonG / totals.totalKwh)} g CO₂e per kWh`
              : undefined
          }
        />
        <StatCard
          label="Active time"
          value={
            totals.totalDurationSeconds === null ? '—' : formatDuration(totals.totalDurationSeconds)
          }
          detail={`across ${totals.samples.toLocaleString('en-US')} samples`}
        />
        <StatCard
          label="Average power"
          value={avgPowerWatts === null ? '—' : formatWatts(avgPowerWatts)}
          detail="energy over active time"
        />
        <StatCard
          label="Sessions"
          value={String(totals.sessions)}
          detail={formatDayRange(totals.firstDay, totals.lastDay)}
        />
        <StatCard
          label="Requests"
          value={String(totals.requests)}
          detail="LLM calls the records cover"
        />
        <StatCard
          label="Average energy per prompt"
          value={
            totals.promptCount > 0
              ? formatJoules(totals.promptEnergyKwh / totals.promptCount)
              : '—'
          }
          detail={`across ${totals.promptCount.toLocaleString('en-US')} prompts — records under 1 kJ excluded`}
        />
      </dl>

      <div className="grid gap-3 lg:grid-cols-3">
        <BreakdownList title="Energy by model" groups={byModel} />
        <BreakdownList title="Energy by agent" groups={byAgent} />
      </div>

      <TopPrompts filter={filter} annotationSyncCount={annotationSyncCount} onPromptClick={focusPrompt} />

      <hr className={"text-zinc-200"}/>

      <PromptChronology
        selectedSession={chronologySession}
        onSelectSession={setChronologySession}
        focus={promptFocus}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  detail,
  footer,
}: {
  label: string
  value: string
  detail?: string
  footer?: ReactNode
}) {
  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <dt className="text-sm text-zinc-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-zinc-900">{value}</dd>
      {detail !== undefined ? <p className="mt-0.5 text-xs text-zinc-500">{detail}</p> : null}
      {footer !== undefined ? footer : null}
    </div>
  )
}

function BreakdownList({ title, groups }: { title: string; groups: readonly GroupEnergy[] }) {
  const max = Math.max(0, ...groups.map(group => group.kwh))

  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      {groups.length === 0 ? (
        <p className="text-sm text-zinc-500">No data</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {groups.map(group => (
            <li key={group.label} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-mono text-zinc-700" title={group.label}>
                  {group.label}
                </span>
                <span className="flex-none text-zinc-500" title={`${group.samples} samples`}>
                  {formatKwh(group.kwh)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-zinc-100">
                <div
                  className="h-1.5 rounded-full bg-emerald-600"
                  style={{ width: `${max > 0 ? (group.kwh / max) * 100 : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function formatWatts(watts: number): string {
  return watts >= 1000 ? `${formatSignificant(watts / 1000)} kW` : `${formatSignificant(watts)} W`
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.round((totalSeconds % 3600) / 60)
    return `${hours}h ${minutes}m`
  }
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = Math.round(totalSeconds % 60)
    return `${minutes}m ${seconds}s`
  }
  return `${formatSignificant(totalSeconds)}s`
}

/** `2026-11-15` → `Nov 15`. */
function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatDayRange(firstDay: string | null, lastDay: string | null): string {
  if (firstDay === null || lastDay === null) {
    return '—'
  }
  return firstDay === lastDay
    ? formatDay(firstDay)
    : `${formatDay(firstDay)} – ${formatDay(lastDay)}`
}
