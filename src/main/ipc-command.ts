import { z } from 'zod'
import type { SendResult } from '../shared/ipc'
import { commandChannels, MAX_COMMAND_LENGTH, MAX_CWD_LENGTH } from '../shared/ipc-command'
import type { IpcHandle } from './ipc-features'

export interface CommandService {
  /** Hands the command to run_shell (approval, folder checks and audit included). */
  run: (command: string, cwd: string) => Promise<SendResult>
}

const commandSchema = z
  .string()
  .max(MAX_COMMAND_LENGTH)
  .refine((command) => command.trim() !== '')
const cwdSchema = z
  .string()
  .min(1)
  .max(MAX_CWD_LENGTH)
  .refine((cwd) => !cwd.includes('\0'))

export function registerCommandHandlers(handle: IpcHandle, command: CommandService): void {
  handle(commandChannels.commandRun, (...args) => {
    if (args.length !== 2) throw new Error('Invalid command.')
    const text = commandSchema.safeParse(args[0])
    if (!text.success) throw new Error('Invalid command.')
    const cwd = cwdSchema.safeParse(args[1])
    if (!cwd.success) throw new Error('Invalid folder.')
    return command.run(text.data, cwd.data)
  })
}
