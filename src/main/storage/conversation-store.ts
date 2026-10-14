import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { readJsonFile, removeFile, writeJsonFile } from './json-file'

interface ConversationFile {
  version: 1
  messages: MessageParam[]
}

export interface ConversationStore {
  /** The saved history, or an empty one plus `error` when the file cannot be read. */
  load: () => Promise<{ messages: MessageParam[]; error: string | null }>
  save: (messages: MessageParam[]) => Promise<void>
  clear: () => Promise<void>
}

function isMessage(value: unknown): value is MessageParam {
  if (typeof value !== 'object' || value === null) return false
  const { role, content } = value as { role?: unknown; content?: unknown }
  return (
    (role === 'user' || role === 'assistant') &&
    (typeof content === 'string' ||
      (Array.isArray(content) &&
        content.every((block) => typeof block === 'object' && block !== null)))
  )
}

function isConversationFile(value: unknown): value is ConversationFile {
  if (typeof value !== 'object' || value === null) return false
  const { version, messages } = value as { version?: unknown; messages?: unknown }
  return version === 1 && Array.isArray(messages) && messages.every(isMessage)
}

/** The current conversation (Messages-API history) as JSON in userData. */
export function createConversationStore(file: string): ConversationStore {
  return {
    async load() {
      try {
        const parsed = await readJsonFile(file)
        if (parsed === undefined) return { messages: [], error: null }
        if (isConversationFile(parsed)) return { messages: parsed.messages, error: null }
      } catch {
        // Fall through: an unreadable file means a fresh conversation, not a crash.
      }
      return {
        messages: [],
        error: 'The saved conversation could not be read, so a new one was started.',
      }
    },
    save: (messages) => writeJsonFile(file, { version: 1, messages } satisfies ConversationFile),
    clear: () => removeFile(file),
  }
}
