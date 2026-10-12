import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin'
import { captureEnergyFromResponse } from './energy.js'
import { flushEnergyRecords } from './energy.store.js'
import { ensureIgnored, findRepoRoot, readGitBranch } from './git.js'
import { flush as flushLog } from './log.js'
import { Energy } from './rpc.js'
import { localOverridePath, localOverrideTempGlob, toggleStore } from './toggle.store.js'

export default Plugin.define({
  id: 'opencode-energy-logger',
  setup: async (ctx) => {
    const directory = ctx.location.directory

    const repoRoot = await findRepoRoot(directory)

    const toggle = await toggleStore({
      defaultEnabled: ctx.options.defaultEnabled !== false,
      directory: repoRoot ?? directory,
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

    // TODO: the promise chain strategy below can be extracted and made generic
    // and has probably been done in an existing library somewhere.

    // flips run one at a time: each flip toggles the state, syncs the http
    // hooks to it and notifies subscribers. overlapping calls would end up
    // with mixed state resulting in upredictable behavior
    let flipQueue: Promise<void> = Promise.resolve()

    const flip = (): Promise<{ enabled: boolean }> => {
      const run = flipQueue.then(async () => {
        const enabled = await toggle.toggle()

        // ensure the local override and its atomic write's temp files are
        // added to .gitignore when needed, but only once the file written by
        // the toggle actually exists
        if (
          repoRoot !== undefined
          && existsSync(join(repoRoot, localOverridePath))
        ) {
          await ensureIgnored(repoRoot, localOverridePath, localOverrideTempGlob)
        }

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

    // captures run unawaited so responses are not held up by the body scan;
    // they are tracked here so the cleanup below can wait for the ones still
    // scanning before the records are flushed
    const pendingCaptures = new Set<Promise<void>>()

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
        // driver, so the (potentially long) body scan must not be awaited
        // here; the capture is tracked instead, so the cleanup can wait for
        // it before flushing the records
        await ctx.session.hook('http.response', (event) => {
          if (!toggle.enabled()) {
            return
          }

          const capture = captureEnergyFromResponse(event, branchByRequest.get(event.request), repoRoot)
          pendingCaptures.add(capture)
          void capture.finally(() => {
            pendingCaptures.delete(capture)
          })
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

      // wait for the body scans of the responses still streaming, so every
      // record they produce reaches the flush below
      await Promise.allSettled([...pendingCaptures])

      // flush energy records
      await flushEnergyRecords()

      // flush logs
      await flushLog()
    }
  },
})
