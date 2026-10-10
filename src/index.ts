import type { Plugin } from '@opencode-ai/plugin'
import { installFetchInterceptor } from './fetch-interceptor.js'
import { log } from './log.js'

export default (async ({ project, directory, worktree }) => {
  log(`loaded in project ${project.vcs === 'git' ? '(git)' : '(no git)'}`)
  log(`directory: ${directory}`)
  log(`worktree: ${worktree}`)

  const uninstallFetchInterceptor = installFetchInterceptor()

  return {
    'event': async ({ event }) => {
      if (event.type === 'message.updated') {
        log(`event: ${event.type}`)
      }
    },
    'tool.execute.after': async (input, output) => {
      log(`tool ${input.tool} finished (${output.title})`)
    },
    'dispose': async () => {
      uninstallFetchInterceptor()
      log('disposed')
    },
  }
}) satisfies Plugin
