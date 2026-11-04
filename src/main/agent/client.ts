import Anthropic from '@anthropic-ai/sdk'
import { cloudFetch, networkErrorMessage } from '../net/network'
import type { AgentClient, AgentEvent } from './types'

export const DEFAULT_MODEL = 'claude-sonnet-5-5'
/** Fixed, so an ANTHROPIC_BASE_URL in the environment cannot move the key. */
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'

/** Main-process only. SDK retries connection failures, 408/409/429 and 5xx twice. */
export function createClaudeClient(apiKey: string): AgentClient {
  return new Anthropic({
    apiKey,
    baseURL: ANTHROPIC_ORIGIN,
    fetch: cloudFetch,
    maxRetries: 2,
    timeout: 120_000,
  })
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
  if ((status === 400 || status === 413) && isContextError(body))
    return {
      type: 'error',
      code: 'context_too_long',
      message: 'This chat is too long for Claude. Start a new chat or fork from a later prompt.',
    }
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
      message: networkErrorMessage(
        'Claude',
        error,
        'Could not connect to Claude. Check your connection and try again.',
      ),
    }
  return { type: 'error', code: 'api', message: 'The Claude request failed. Please try again.' }
}

/**
 * Anthropic's answer to a history over the context window: 400 `invalid_request_error`
 * "prompt is too long: … tokens > … maximum" (or "input length and `max_tokens` exceed
 * context limit"), or 413 `request_too_large`. Matched only; the text is never shown.
 */
const CONTEXT_ERROR =
  /prompt is too long|exceed(?:s|ed)? (?:the )?context (?:limit|window)|context[ _-]?window|request_too_large/i

function isContextError(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const inner: unknown = 'error' in body ? body.error : undefined
  const record = typeof inner === 'object' && inner !== null ? inner : body
  const type = 'type' in record && typeof record.type === 'string' ? record.type : ''
  const message =
    'message' in record && typeof record.message === 'string' ? record.message.slice(0, 2000) : ''
  return type === 'request_too_large' || CONTEXT_ERROR.test(message)
}
