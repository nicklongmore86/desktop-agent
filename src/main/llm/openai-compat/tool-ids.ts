import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { OpenAICompatError } from './errors'

/**
 * Every alias is `call` plus five base-36 digits: nine ASCII letters and digits. That suits
 * every id rule we know of: Claude's ^[a-zA-Z0-9_-]+$, the 40 characters OpenAI's Chat
 * Completions route is reported to enforce, the Responses API's documented 64, and the
 * nine-character ids some Mistral routes on OpenRouter require.
 */
export const TOOL_ID_ALIAS = /^call[0-9a-z]{5}$/
const MAX_ALIASES = 36 ** 5

export const UNMATCHED_RESULT_MESSAGE =
  'The conversation has a tool result without its tool call, so it was not sent.'

/**
 * Request-scoped tool-call ids. A saved chat's ids come from many providers (Anthropic
 * `toolu_…`, Gemini `toolu_gemini_…`, bridge UUIDs, `call_…` hashes), and some routes refuse
 * ids in a foreign format or over a length. Each saved id is sent as a short alias,
 * numbered in order of first appearance, so the same history gives the same aliases on
 * every turn (prompt caching keeps working). Aliases live only in the request: they are
 * never saved, and the ids the provider returns for new calls become new saved ids
 * (see newToolUseId).
 */
export class ToolIdAliases {
  private readonly bySaved = new Map<string, string>()
  private readonly byAlias = new Map<string, string>()

  /** The alias for a saved tool_use id, assigned on first use. */
  alias(savedId: string): string {
    const known = this.bySaved.get(savedId)
    if (known) return known
    if (this.bySaved.size >= MAX_ALIASES)
      throw new OpenAICompatError('invalid_request', 'The conversation has too many tool calls.')
    const alias = `call${this.bySaved.size.toString(36).padStart(5, '0')}`
    this.bySaved.set(savedId, alias)
    this.byAlias.set(alias, savedId)
    return alias
  }

  /** The saved id an alias stands for, if this request issued it. */
  savedId(alias: string): string | undefined {
    return this.byAlias.get(alias)
  }

  get size(): number {
    return this.bySaved.size
  }
}

/**
 * Pairs tool results with calls as the transcript does (conversation-store.ts): a result
 * answers, once, a call of the assistant message just before its own message. Anything else
 * means the history is damaged, so the request is refused rather than sent without it.
 */
export class ToolCallPairing {
  private open = new Set<string>()
  constructor(readonly aliases: ToolIdAliases = new ToolIdAliases()) {}

  /** Alias for a call (next() makes an assistant message's calls answerable). */
  call(savedId: string): string {
    return this.aliases.alias(savedId)
  }

  /** Alias for a result; throws when it answers no open call. */
  result(savedId: string): string {
    if (!this.open.delete(savedId))
      throw new OpenAICompatError('protocol', UNMATCHED_RESULT_MESSAGE)
    return this.aliases.alias(savedId)
  }

  /** Call after each message: only an assistant message's calls stay answerable. */
  next(message: MessageParam): void {
    this.open =
      message.role === 'assistant' && typeof message.content !== 'string'
        ? new Set(message.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])))
        : new Set()
  }
}

/** Every tool id the history already uses (calls and results). */
export function savedToolIds(messages: readonly MessageParam[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content)
      if (block.type === 'tool_use') ids.add(block.id)
      else if (block.type === 'tool_result') ids.add(block.tool_use_id)
  }
  return ids
}
