import type { Plugin } from '@opencode-ai/plugin'
import { log } from './log.js'

export default (async ({ project, directory, worktree }) => {
  log(`loaded in project ${project.vcs === 'git' ? '(git)' : '(no git)'}`)
  log(`directory: ${directory}`)
  log(`worktree: ${worktree}`)

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
      log('disposed')
    },
  }
}) satisfies Plugin
