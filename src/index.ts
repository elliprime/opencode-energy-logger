import { Plugin } from '@opencode/plugin'
import { captureEnergyFromResponse } from './energy.js'
import { readGitBranch } from './git.js'
import { drain } from './log.js'
import { Energy } from './rpc.js'
import { toggleStore } from './toggle.store.js'

export default Plugin.define({
  id: 'opencode-energy-logger',
  setup: async (ctx) => {
    const directory = ctx.location.directory

    const toggle = await toggleStore({
      defaultEnabled: ctx.options.defaultEnabled !== false,
      directory,
      storage: ctx.storage,
    })

    const registration = await ctx.rpc.register(Energy, {
      get: async () => ({ enabled: toggle.enabled() }),
      toggle: async (_input, context) => {
        try {
          return await flip()
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return context.error('toggle_failed', `could not toggle energy logging: ${reason}`, { message: reason })
        }
      },
    })

    // TODO: the serialization strategy below can be extracted and made generic
    // and has probably been done in an existing library somewhere.

    // flips run one at a time: each flip toggles the state, syncs the http
    // hooks to it and notifies subscribers. overlapping calls would end up
    // with mixed state resulting in upredictable behavior
    let flipQueue: Promise<void> = Promise.resolve()

    const flip = (): Promise<{ enabled: boolean }> => {
      const run = flipQueue.then(async () => {
        const enabled = await toggle.toggle()

        if (enabled) {
          await registerHooks()
        } else {
          await unregisterHooks()
        }

        await registration.events.emit('toggled', { directory, enabled })

        return { enabled }
      })

      // a failed flip must not stop the queue
      flipQueue = run.then(() => {}, () => {})
      return run
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'energy',
        description: 'Toggle energy logging for this folder',
        execute: async () => {
          await flip()
        },
      })
    })

    // the response event carries the same request instance, so the branch read
    // for a request can be matched to its response; entries for requests that
    // never complete are dropped along with the request object
    const branchByRequest = new WeakMap<Request, () => Promise<string | undefined>>()

    // the http hooks stay unregistered while logging is disabled, so opencode
    // doesn't do any work at all in this case
    let hooks: Array<{ dispose: () => Promise<void> }> | undefined

    const registerHooks = async () => {
      if (hooks !== undefined) {
        return
      }

      hooks = [
        await ctx.session.hook('http.request', (event) => {
          // the branch read is lazy: only started once a record is about
          // to be written, so requests that log nothing spawn no git process
          branchByRequest.set(event.request, () => readGitBranch(directory))
        }),

        // the hook callback runs before the response continues to the model
        // driver, so the (potentially long) body scan must not be awaited here
        await ctx.session.hook('http.response', (event) => {
          if (!toggle.enabled()) {
            return
          }

          void captureEnergyFromResponse(event, branchByRequest.get(event.request))
        }),
      ]
    }

    const unregisterHooks = async () => {
      const registered = hooks
      hooks = undefined
      if (registered !== undefined) {
        await Promise.allSettled(registered.map(entry => entry.dispose()))
      }
    }

    if (toggle.enabled()) {
      await registerHooks()
    }

    return async () => {
      // let queued flips settle
      await flipQueue

      // stop new captures
      await unregisterHooks()

      // then flush pending writes
      await drain()
    }
  },
})
