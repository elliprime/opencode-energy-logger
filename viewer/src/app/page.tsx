import { EnergyDirectoryPicker } from '@/components/energy-directory-picker'

export default function Home() {
  return (
    <main className="flex min-h-screen w-full flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Energy viewer</h1>
        <p className="text-sm text-zinc-600">
          Analyze the energy usage records that opencode-energy-logger captured in the .energy directory of a
          repository.
        </p>
      </header>
      <EnergyDirectoryPicker />
    </main>
  )
}
