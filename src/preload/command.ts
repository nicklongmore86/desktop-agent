import { commandChannels, type CommandApi } from '../shared/ipc-command'
import type { Invoke } from './features'

export const commandApi = (invoke: Invoke): CommandApi => ({
  command: {
    run: (command, cwd) => invoke(commandChannels.commandRun, command, cwd),
  },
})
