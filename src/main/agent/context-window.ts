import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

/** The message for a chat that does not fit its model's context window. Names no provider text. */
export function contextTooLongMessage(model: string): string {
  return `This chat is too long for ${model}. Start a new chat, fork from a later prompt, or switch to a model with a larger context.`
}

/**
 * Characters per token for the check before a request. Real text is about 4 (English)
 * and less for code and most other scripts, so 5 gives a count below the real one:
 * the check only refuses a request the model would refuse too.
 */
const CHARS_PER_TOKEN = 5
/** What an image costs at most, about, whatever its encoded size. */
const IMAGE_TOKENS = 1_600

/**
 * A low estimate of the tokens a request's messages, system prompt and tools take.
 * Images count a fixed amount instead of their base64 text.
 */
export function estimateTokens(
  messages: readonly MessageParam[],
  extra: readonly unknown[] = [],
): number {
  let chars = 0
  let images = 0
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      chars += value.length
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item)
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (record['type'] === 'image') {
        images += 1
        return
      }
      for (const item of Object.values(record)) visit(item)
    }
  }
  visit(messages)
  visit(extra)
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS
}

/** A context window as a model list reports it: a positive whole number of tokens, or none. */
export function contextWindowOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
