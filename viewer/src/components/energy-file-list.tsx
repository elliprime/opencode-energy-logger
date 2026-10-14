interface EnergyFileListProps {
  source: string
  filenames: string[]
}

export function EnergyFileList({ source, filenames }: EnergyFileListProps) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-xs">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold text-zinc-900">Energy files</h2>
        <span className="text-xs text-zinc-500">
          {filenames.length} {filenames.length === 1 ? 'file' : 'files'}
        </span>
      </div>
      <p className="truncate text-xs text-zinc-500" title={source}>
        from {source}
      </p>
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
        {filenames.map(filename => (
          <li key={filename} className="px-3 py-2 font-mono text-xs break-all text-zinc-800">
            {filename}
          </li>
        ))}
      </ul>
    </section>
  )
}
