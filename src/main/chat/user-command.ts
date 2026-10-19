import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { ChatItem } from '../../shared/ipc'
import type { StoredMessage } from '../storage/conversation-store'

/**
 * A command the user ran from the command bar is saved as a user message: the model
 * reads it as something the user did (not a call it made), and the chat view shows it
 * as a tool card. The first line marks it. Chat messages are always saved as plain
 * strings (see ChatSession.send), so typing this header in the composer never makes a
 * card; only a one-text-block array message starting with it does.
 */
export const USER_COMMAND_HEADER =
  '[Desktop Agent command bar] The user ran this command themselves; it was not an assistant tool call.'

export interface UserCommandRecord {
  id: string
  command: string
  cwd: string
  output: string
  isError: boolean
  /** The user declined the approval. Absent in commands saved before it was recorded. */
  declined?: boolean
}

export function userCommandMessage(record: UserCommandRecord): MessageParam {
  return {
    role: 'user',
    content: [{ type: 'text', text: `${USER_COMMAND_HEADER}\n${JSON.stringify(record)}` }],
  }
}

const isString = (value: unknown): value is string => typeof value === 'string'

/** The card for a saved user command, or null if `message` is not one. */
export function userCommandItem(
  message: StoredMessage,
): Extract<ChatItem, { kind: 'tool' }> | null {
  if (message.role !== 'user' || !Array.isArray(message.content)) return null
  const [block, ...rest] = message.content
  if (!block || rest.length > 0 || block.type !== 'text') return null
  if (!block.text.startsWith(`${USER_COMMAND_HEADER}\n`)) return null
  let record: unknown
  try {
    record = JSON.parse(block.text.slice(USER_COMMAND_HEADER.length + 1))
  } catch {
    return null
  }
  if (typeof record !== 'object' || record === null) return null
  const { id, command, cwd, output, isError, declined } = record as Record<string, unknown>
  if (!isString(id) || !isString(command) || !isString(cwd) || !isString(output)) return null
  if (typeof isError !== 'boolean') return null
  if (declined !== undefined && typeof declined !== 'boolean') return null
  return {
    kind: 'tool',
    id,
    name: 'run_shell',
    input: { command, cwd },
    result: { content: output, isError, ...(declined === undefined ? {} : { declined }) },
    origin: 'user-terminal',
  }
}
