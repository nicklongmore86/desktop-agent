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

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

function isTextBlock(block: Obj): boolean {
  return (
    nonEmpty(block['text']) &&
    (block['citations'] === undefined ||
      block['citations'] === null ||
      Array.isArray(block['citations']))
  )
}

function isToolUse(block: Obj): boolean {
  return nonEmpty(block['id']) && nonEmpty(block['name']) && isObject(block['input'])
}

function isToolResult(block: Obj): boolean {
  const { content, is_error: isError } = block
  return (
    nonEmpty(block['tool_use_id']) &&
    (content === undefined ||
      typeof content === 'string' ||
      (Array.isArray(content) &&
        content.every(
          (part) => isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string',
        ))) &&
    (isError === undefined || typeof isError === 'boolean')
  )
}

/**
 * The blocks each role may hold, checked by discriminant. Maps, not object
 * literals: an untrusted `type` like "toString" or "__proto__" must never
 * reach an inherited property. Anything not listed is rejected.
 */
const BLOCK_CHECKS = new Map<string, ReadonlyMap<string, (block: Obj) => boolean>>([
  [
    'user',
    new Map([
      ['text', isTextBlock],
      ['tool_result', isToolResult],
    ]),
  ],
  [
    'assistant',
    new Map([
      ['text', isTextBlock],
      ['tool_use', isToolUse],
    ]),
  ],
])

function isMessage(value: unknown): value is MessageParam {
  if (!isObject(value)) return false
  const { role, content } = value
  const checks = typeof role === 'string' ? BLOCK_CHECKS.get(role) : undefined
  if (!checks) return false
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every((block) => {
    if (!isObject(block)) return false
    const type = block['type']
    const check = typeof type === 'string' ? checks.get(type) : undefined
    return check !== undefined && check(block)
  })
}

function blockIds(message: MessageParam, type: 'tool_use' | 'tool_result'): string[] {
  if (typeof message.content === 'string') return []
  return message.content.flatMap((block) =>
    block.type === 'tool_use' && type === 'tool_use'
      ? [block.id]
      : block.type === 'tool_result' && type === 'tool_result'
        ? [block.tool_use_id]
        : [],
  )
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id))

/**
 * Basic structure the API requires: the history starts with the user, and
 * every assistant tool call is answered, exactly, by the next user message.
 * Consecutive user (a failed run) or assistant (pause_turn) messages are allowed.
 */
function isWellFormed(messages: MessageParam[]): boolean {
  if (messages.length > 0 && messages[0]?.role !== 'user') return false
  return messages.every((message, index) => {
    const previous = messages[index - 1]
    const next = messages[index + 1]
    const calls = blockIds(message, 'tool_use')
    const results = blockIds(message, 'tool_result')
    if (results.length > 0) {
      if (previous?.role !== 'assistant' || !sameSet(results, blockIds(previous, 'tool_use')))
        return false
    }
    if (calls.length > 0) {
      if (next?.role !== 'user' || !sameSet(calls, blockIds(next, 'tool_result'))) return false
    }
    return true
  })
}

function isConversationFile(value: unknown): value is ConversationFile {
  if (!isObject(value)) return false
  const { version, messages } = value
  return (
    version === 1 && Array.isArray(messages) && messages.every(isMessage) && isWellFormed(messages)
  )
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
