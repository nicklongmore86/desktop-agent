import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import { httpError, sanitize } from './errors'
import {
  GIF_PLACEHOLDER,
  multimodalFunctionResponses,
  SKIP_SIGNATURE,
  TOOL_IMAGES_NOTE,
  toGeminiRequest,
  toStopReason,
  toUsage,
} from './translate'
import type { CallRecord } from './types'

const params = (
  messages: MessageCreateParamsNonStreaming['messages'],
  extra: Partial<MessageCreateParamsNonStreaming> = {},
): MessageCreateParamsNonStreaming => ({ model: 'x', max_tokens: 100, messages, ...extra })

describe('toGeminiRequest', () => {
  it('maps the system prompt, text, tools and token limit', () => {
    const request = toGeminiRequest(
      params([{ role: 'user', content: 'Hi' }], {
        system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
        tools: [
          {
            name: 'none',
            description: 'No input',
            input_schema: { type: 'object', properties: {} },
          },
          {
            name: 'read',
            description: 'Read',
            input_schema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      }),
      new Map(),
    )
    expect(request).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      tools: [
        {
          functionDeclarations: [
            { name: 'none', description: 'No input' },
            {
              name: 'read',
              description: 'Read',
              parameters: {
                type: 'OBJECT',
                properties: { path: { type: 'STRING' } },
                required: ['path'],
              },
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 100 },
    })
    expect(JSON.stringify(request)).not.toContain('cache_control')
  })

  it('round-trips tool calls with Gemini ids and signatures, and keeps errors', () => {
    const calls = new Map<string, CallRecord>([
      ['toolu_a', { geminiId: 'g-a', signature: 'sig-a' }],
      ['toolu_b', { geminiId: 'g-b' }],
    ])
    const request = toGeminiRequest(
      params([
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden', signature: 'claude-sig' },
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_a', name: 'read', input: { path: 'a' } },
            { type: 'tool_use', id: 'toolu_b', name: 'list', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', content: 'contents' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_b',
              content: [
                { type: 'text', text: 'denied' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
              ],
              is_error: true,
            },
          ],
        },
      ]),
      calls,
    )
    expect(request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Go' }] },
      {
        role: 'model',
        parts: [
          { text: 'Checking.' },
          {
            functionCall: { id: 'g-a', name: 'read', args: { path: 'a' } },
            thoughtSignature: 'sig-a',
          },
          { functionCall: { id: 'g-b', name: 'list', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'g-a', name: 'read', response: { output: 'contents' } } },
          { functionResponse: { id: 'g-b', name: 'list', response: { error: 'denied' } } },
          // Before Gemini 3, a function response holds no images: they follow, marked.
          { text: TOOL_IMAGES_NOTE },
          { inlineData: { mimeType: 'image/png', data: 'AA' } },
        ],
      },
    ])
    expect(JSON.stringify(request)).not.toContain('hidden')
    expect(JSON.stringify(request)).not.toContain('claude-sig')
  })

  it('signs unknown calls with the documented skip value, sends images inline and drops empty turns', () => {
    const request = toGeminiRequest(
      params([
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
            { type: 'text', text: 'What is this?' },
          ],
        },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] },
        { role: 'user', content: 'Still there?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'old_1', name: 'read', input: {} },
            { type: 'tool_use', id: 'old_2', name: 'read', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_1', content: 'x' }] },
      ]),
      new Map(),
    )
    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'AA' } },
          { text: 'What is this?' },
          { text: 'Still there?' },
        ],
      },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read', args: {} }, thoughtSignature: SKIP_SIGNATURE },
          { functionCall: { name: 'read', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read', response: { output: 'x' } } }],
      },
    ])
  })
})

describe('toStopReason and toUsage', () => {
  it.each([
    ['STOP', false, 'end_turn'],
    ['STOP', true, 'tool_use'],
    ['MAX_TOKENS', true, 'max_tokens'],
    ['SAFETY', false, 'refusal'],
    ['RECITATION', false, 'refusal'],
    ['PROHIBITED_CONTENT', false, 'refusal'],
    ['OTHER', false, null],
    [undefined, false, null],
  ] as const)('%s (calls: %s) -> %s', (finish, calls, expected) => {
    expect(toStopReason(finish, calls)).toBe(expected)
  })

  it('reports cached and thinking tokens', () => {
    expect(
      toUsage({
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 5,
      }),
    ).toMatchObject({
      input_tokens: 60,
      cache_read_input_tokens: 40,
      output_tokens: 15,
      output_tokens_details: { thinking_tokens: 5 },
    })
    expect(toUsage(undefined)).toMatchObject({ input_tokens: 0, output_tokens: 0 })
  })
})

describe('httpError', () => {
  const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklmnop'
  const body = (status: string, message: string, details: unknown[] = []) => ({
    error: { code: 0, status, message, details },
  })
  const now = () => Date.parse('2026-01-01T00:00:00Z')

  it.each([
    [
      400,
      body('INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
      ]),
      'authentication',
    ],
    [400, body('INVALID_ARGUMENT', 'Invalid JSON payload'), 'invalid_request'],
    [400, body('INVALID_ARGUMENT', 'The input token count exceeds the maximum'), 'context_limit'],
    [401, undefined, 'authentication'],
    [402, undefined, 'usage_limit'],
    [403, body('PERMISSION_DENIED', 'Your API key was reported as leaked.'), 'authentication'],
    [403, body('PERMISSION_DENIED', 'Method not allowed for this project.'), 'permission'],
    [404, body('NOT_FOUND', 'models/x is not found'), 'model_unavailable'],
    [500, body('INTERNAL', 'oops'), 'api'],
    [503, body('UNAVAILABLE', 'The model is overloaded.'), 'overloaded'],
    [504, body('DEADLINE_EXCEEDED', 'slow'), 'api'],
  ] as const)('%i -> %s', (status, response, code) => {
    expect(httpError(status, response, KEY).code).toBe(code)
  })

  it('maps 429 to a rate limit or a daily usage limit with the retry delay', () => {
    const minute = httpError(
      429,
      body('RESOURCE_EXHAUSTED', 'quota', [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' },
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
        },
      ]),
      KEY,
      null,
      now,
    )
    expect(minute).toMatchObject({ code: 'rate_limit', resetsAt: '2026-01-01T00:00:38.000Z' })
    const daily = httpError(
      429,
      body('RESOURCE_EXHAUSTED', 'quota', [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
        },
      ]),
      KEY,
      '120',
      now,
    )
    expect(daily).toMatchObject({ code: 'usage_limit', resetsAt: '2026-01-01T00:02:00.000Z' })
    expect(httpError(429, undefined, KEY).resetsAt).toBeUndefined()
  })

  it('never repeats the key and caps server text', () => {
    const error = httpError(
      400,
      body('INVALID_ARGUMENT', `Bad value ${KEY} at ?key=${KEY}&x=1 ${'z'.repeat(500)}`),
      KEY,
    )
    expect(error.code).toBe('invalid_request')
    expect(error.message).not.toContain(KEY)
    expect(error.message).not.toContain('AIza')
    expect(error.message.length).toBeLessThan(250)
    expect(sanitize(`line\none\u0007 AIzaOtherKeyLooking_like_this-123456789`, KEY)).toBe(
      'line one [redacted]',
    )
  })

  it('puts tool images inside the function response on Gemini 3 and later, with their labels', () => {
    const history: MessageCreateParamsNonStreaming['messages'] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'Two pages.' },
              { type: 'text', text: '[Image: page 1]' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'J1' } },
              { type: 'text', text: '[Image: page 2]' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'P2' } },
            ],
          },
          { type: 'text', text: 'And this?' },
        ],
      },
    ]
    const modern = toGeminiRequest(params(history, { model: 'gemini-3-pro-preview' }), new Map())
    expect(modern.contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read',
            response: { output: 'Two pages.\n[Image: page 1]\n[Image: page 2]' },
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: 'J1' } },
              { inlineData: { mimeType: 'image/png', data: 'P2' } },
            ],
          },
        },
        { text: 'And this?' },
      ],
    })
    const older = toGeminiRequest(params(history, { model: 'gemini-2.5-flash' }), new Map())
    expect(older.contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read',
            response: { output: 'Two pages.\n[Image: page 1]\n[Image: page 2]' },
          },
        },
        { text: TOOL_IMAGES_NOTE },
        { text: '[Image: page 1]' },
        { inlineData: { mimeType: 'image/jpeg', data: 'J1' } },
        { text: '[Image: page 2]' },
        { inlineData: { mimeType: 'image/png', data: 'P2' } },
        { text: 'And this?' },
      ],
    })
  })

  it('replaces a GIF, which Gemini does not read, with a placeholder', () => {
    const request = toGeminiRequest(
      params([
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0' } },
          ],
        },
      ]),
      new Map(),
    )
    expect(request.contents).toEqual([{ role: 'user', parts: [{ text: GIF_PLACEHOLDER }] }])
  })

  it('knows which models take images in function responses', () => {
    expect(multimodalFunctionResponses('gemini-3-flash')).toBe(true)
    expect(multimodalFunctionResponses('models/gemini-3.1-pro')).toBe(true)
    expect(multimodalFunctionResponses('gemini-2.5-pro')).toBe(false)
    expect(multimodalFunctionResponses('gemini-flash-latest')).toBe(false)
    expect(multimodalFunctionResponses('gemma-3-27b-it')).toBe(false)
  })
})
