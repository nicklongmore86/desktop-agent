/**
 * The command bar (Chat | Command): channel names and limits shared by main, preload
 * and renderer. One of the per-feature IPC modules; see docs/ipc-modules.md.
 *
 * A typed command is not a new way to run things: main hands it to the agent's own
 * run_shell tool, so it gets the same folder checks, approval prompt, hardened launch,
 * output limits and audit entry (marked `origin: 'user-terminal'`).
 */
import type { SendResult } from './ipc'

export const commandChannels = {
  commandRun: 'command:run',
} as const

/** run_shell refuses longer commands; the renderer and main check it first. */
export const MAX_COMMAND_LENGTH = 8000
/** Longest cwd main accepts (Windows long paths). */
export const MAX_CWD_LENGTH = 32_767

export interface CommandApi {
  command: {
    /**
     * Runs `command` in `cwd` (a granted folder) once the user approves it in the usual
     * prompt. Resolves once it has started, like chat.send; refused (`busy`) while a
     * reply, another command or an approval is in flight.
     */
    run: (command: string, cwd: string) => Promise<SendResult>
  }
}
