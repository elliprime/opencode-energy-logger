import { Plugin } from '@opencode/plugin/tui'
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { Energy } from './rpc.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function enabledOf(value: unknown): boolean | undefined {
  return isRecord(value) && typeof value.enabled === 'boolean' ? value.enabled : undefined
}

function EnergyIcon(props: { context: Plugin.Context }) {
  const rpc = props.context.client.rpc(Energy)
  const [enabled, setEnabled] = createSignal<boolean | undefined>(undefined)

  let isComponentActive = true

  // bumped for every query so retries and folder switches drop stale answers
  let latestQueryId = 0

  // the server plugin may still be activating when the footer first
  // renders, so keep retrying until it answers
  const refresh = async () => {
    if (!isComponentActive) {
      return
    }

    const currentQueryId = ++latestQueryId
    try {
      const result = enabledOf(await rpc.get({}, { location: props.context.location }))
      if (isComponentActive && currentQueryId === latestQueryId && result !== undefined) {
        setEnabled(result)
        return
      }
    } catch {
      // fall through and retry
    }

    if (isComponentActive && currentQueryId === latestQueryId) {
      setTimeout(refresh, 1000)
    }
  }

  // the icon shows the folder opencode is in, so re-query when it changes
  createEffect(on(() => props.context.location, () => void refresh()))

  onMount(() => {
    // keep the icon in sync with toggles from other surfaces, like /energy
    const unsubscribe = rpc.events.on('toggled', (event) => {
      const data = event.data
      if (!isRecord(data)) {
        return // malformed data (sanity check)
      }

      const next = enabledOf(data)
      if (next === undefined || typeof data.directory !== 'string') {
        return // malformed data
      }

      const location = props.context.location
      if (location !== undefined && data.directory !== location.directory) {
        return // data is for a different directory (or there is no directory)
      }

      setEnabled(next)
    })

    onCleanup(() => {
      isComponentActive = false
      unsubscribe()
    })
  })

  const toggle = () => {
    void rpc
      .toggle({}, { location: props.context.location })
      .then((result) => {
        const changedValue = enabledOf(result)
        if (changedValue !== undefined) {
          setEnabled(changedValue)
        }
      })
      .catch((error: unknown) => {
        // the change was not saved: keep showing the real state and say why
        props.context.ui.toast.show({
          title: 'Energy logging',
          message: isRecord(error) && typeof error.message === 'string'
            ? error.message
            : 'failed to toggle energy logging',
          variant: 'error',
        })
      })
  }

  return (
    <Show when={enabled() !== undefined}>
      <box flexDirection="row" flexShrink={0} marginRight={-1}>
        <text
          fg={props.context.theme.text.feedback.success.base}
          opacity={enabled() ? 1 : 0.4}
          onMouseUp={toggle}
        >
          {`⚡ ${enabled() ? 'on' : 'off'}`}
        </text>
        <text fg={props.context.theme.text.muted}> ·</text>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: 'opencode-energy-logger',
  setup(context) {
    const unclaim = context.ui.slot({
      append: 'prompt.footer.status',
      render: () => <EnergyIcon context={context} />,
    })

    return () => {
      unclaim()
    }
  },
})
