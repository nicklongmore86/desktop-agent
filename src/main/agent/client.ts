import Anthropic from '@anthropic-ai/sdk'
import type { AgentClient, AgentEvent } from './types'

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** Main-process only. SDK retries connection failures, 408/409/429 and 5xx twice. */
export function createClaudeClient(apiKey: string): AgentClient {
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 })
}

/** Do not forward raw SDK errors: they can contain request data. */
export function apiErrorEvent(error: unknown): Extract<AgentEvent, { type: 'error' }> {
  const status: unknown = error instanceof Anthropic.APIError ? error.status : undefined
  const body: unknown = error instanceof Anthropic.APIError ? error.error : undefined
  const streamErrorType: unknown =
    error instanceof Anthropic.APIError && status === undefined
      ? (error.type ??
        (typeof body === 'object' && body !== null && 'type' in body ? body.type : undefined))
      : undefined
  if (status === 400 || status === 404 || status === 413)
    return {
      type: 'error',
      code: 'invalid_request',
      message: 'Claude rejected the request. Check the model, message format and request size.',
    }
  if (error instanceof Anthropic.APIError && error.status === 403)
    return {
      type: 'error',
      code: 'permission',
      message: 'Claude denied access. Check the API key permissions and model access.',
    }
  if (error instanceof Anthropic.AuthenticationError)
    return {
      type: 'error',
      code: 'authentication',
      message: 'Claude rejected the API key. Update it in settings.',
    }
  if (
    (error instanceof Anthropic.APIError && error.status === 429) ||
    streamErrorType === 'rate_limit_error'
  )
    return {
      type: 'error',
      code: 'rate_limit',
      message: 'Claude rate limit reached. Try again later.',
    }
  if (
    (error instanceof Anthropic.APIError && error.status === 529) ||
    streamErrorType === 'overloaded_error'
  )
    return {
      type: 'error',
      code: 'overloaded',
      message: 'Claude is overloaded. Try again later.',
    }
  if (error instanceof Anthropic.APIConnectionError)
    return {
      type: 'error',
      code: 'network',
      message: 'Could not connect to Claude. Check your connection and try again.',
    }
  return { type: 'error', code: 'api', message: 'The Claude request failed. Please try again.' }
}
