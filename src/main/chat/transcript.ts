import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { ChatItem } from '../../shared/ipc'

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      'text' in block &&
      typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('')
}

/**
 * The chat view of a Messages-API history: user and assistant text, and one
 * tool card per tool_use with its matching tool_result. Tool-result-only user
 * messages are folded into the cards, not shown as user text.
 */
export function toTranscript(messages: readonly MessageParam[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  messages.forEach((message, m) => {
    const role = message.role
    if (role !== 'user' && role !== 'assistant') return
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content
    blocks.forEach((block, b) => {
      const id = `h${String(m)}.${String(b)}`
      if (block.type === 'text') {
        if (!block.text) return
        const last = items.at(-1)
        // Adjacent text blocks of one message read as one bubble.
        if (last && last.kind === role && last.id.startsWith(`h${String(m)}.`)) {
          last.text += `\n\n${block.text}`
        } else {
          items.push({ kind: role, id, text: block.text })
        }
      } else if (block.type === 'tool_use') {
        const card: Extract<ChatItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: block.id,
          name: block.name,
          input: block.input,
          result: null,
        }
        tools.set(block.id, card)
        items.push(card)
      } else if (block.type === 'tool_result') {
        const card = tools.get(block.tool_use_id)
        if (card)
          card.result = { content: resultText(block.content), isError: block.is_error === true }
      }
    })
  })
  return items
}
