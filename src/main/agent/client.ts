import Anthropic from '@anthropic-ai/sdk'
import type { AgentClient, AgentEvent } from './types'

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** Main-process only. SDK retries connection failures, 408/409/429 and 5xx twice. */
export function createClaudeClient(apiKey: string): AgentClient {
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 })
}

/** Do not forward raw SDK errors: they can contain request data. */
export function apiErrorEvent(error: unknown): Extract<AgentEvent, { type: 'error' }> {
  if (error instanceof Anthropic.AuthenticationError)
    return {
      type: 'error',
      code: 'authentication',
      message: 'Claude rejected the API key. Update it in settings.',
    }
  if (error instanceof Anthropic.APIError && error.status === 429)
    return {
      type: 'error',
      code: 'rate_limit',
      message: 'Claude rate limit reached after retries. Try again later.',
    }
  if (error instanceof Anthropic.APIError && error.status === 529)
    return {
      type: 'error',
      code: 'overloaded',
      message: 'Claude is overloaded after retries. Try again later.',
    }
  if (error instanceof Anthropic.APIConnectionError)
    return {
      type: 'error',
      code: 'network',
      message: 'Could not connect to Claude. Check your connection and try again.',
    }
  return { type: 'error', code: 'api', message: 'The Claude request failed. Please try again.' }
}
