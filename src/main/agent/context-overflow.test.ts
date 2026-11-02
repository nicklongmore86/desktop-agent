import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it, vi } from 'vitest'
import { httpError as geminiHttpError } from '../llm/gemini/errors'
import { geminiErrorEvent } from '../llm/gemini'
import { openAICompatErrorEvent } from '../llm/openai-compat'
import { statusError } from '../llm/openai-compat/errors'
import { responsesError } from '../llm/openai-responses/errors'
import { CLAUDE_FAILURES, CODEX_FAILURES, mapFailure } from '../providers/errors'
import { apiErrorEvent } from './client'
import { contextTooLongMessage, contextWindowOf, estimateTokens } from './context-window'
import { createAgent } from './index'
import type { AgentClient, AgentEvent } from './types'

/** Provider text that must never reach the user. */
const LEAK = /sk-|AIza|tokens >|secret|maximum context|exceeds|overflows|Prompt is too long/i

describe('context-length errors map to context_too_long for every provider', () => {
  it('Anthropic: 400 "prompt is too long" and 413 request_too_large', () => {
    const tooLong = Anthropic.APIError.generate(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 250000 tokens > 200000 maximum sk-secret',
        },
      },
      'prompt is too long',
      new Headers(),
    )
    const tooLarge = Anthropic.APIError.generate(
      413,
      { type: 'error', error: { type: 'request_too_large', message: 'Request exceeds size' } },
      'too large',
      new Headers(),
    )
    for (const error of [tooLong, tooLarge]) {
      const event = apiErrorEvent(error)
      expect(event.code).toBe('context_too_long')
      expect(event.message).not.toMatch(LEAK)
    }
    // Any other 400 stays a rejected request.
    const other = Anthropic.APIError.generate(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad tool schema' } },
      'bad',
      new Headers(),
    )
    expect(apiErrorEvent(other).code).toBe('invalid_request')
  })

  it.each([
    ['OpenAI', 400, { error: { code: 'context_length_exceeded', message: 'sk-secret' } }],
    [
      'OpenRouter',
      400,
      { error: { code: 400, message: "This endpoint's maximum context length is 8192 tokens" } },
    ],
    [
      'LM Studio',
      400,
      {
        error:
          'Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens',
      },
    ],
    [
      'LM Studio (500)',
      500,
      {
        error:
          'The number of tokens to keep from the initial prompt is greater than the context length',
      },
    ],
    ['Ollama', 500, { error: 'input length exceeds the context length' }],
    [
      'Ollama (prompt)',
      400,
      { error: 'prompt too long; exceeded max context length by 12 tokens' },
    ],
  ])('OpenAI-compatible (%s)', (label, status, body) => {
    const event = openAICompatErrorEvent(statusError(status, body, label))
    expect(event.code).toBe('context_too_long')
    expect(event.message).not.toMatch(LEAK)
  })

  it('OpenAI-compatible: other errors are not mistaken for it', () => {
    expect(
      openAICompatErrorEvent(statusError(500, { error: 'model crashed' }, 'Ollama')).code,
    ).not.toBe('context_too_long')
    expect(
      openAICompatErrorEvent(statusError(401, { error: { message: 'context length' } }, 'OpenAI'))
        .code,
    ).toBe('authentication')
  })

  it('Responses (ChatGPT · Plan): the code, or the text of an in-stream failure', () => {
    for (const [error, status] of [
      [{ code: 'context_length_exceeded', message: 'sk-secret' }, 400],
      [{ code: 'context_window_exceeded' }, undefined],
      [{ message: 'Your input exceeds the context window of this model.' }, undefined],
    ] as const) {
      const mapped = responsesError(error, status)
      expect(mapped.code).toBe('context_too_long')
      expect(mapped.message).not.toMatch(LEAK)
    }
  })

  it('Gemini: 400 input token count over the limit', () => {
    const key = 'AIzaSyFAKEKEY_for_tests_0123456789abcd'
    const error = geminiHttpError(
      400,
      {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: `The input token count (1200000) exceeds the maximum number of tokens allowed (1048576). ${key}`,
        },
      },
      key,
    )
    const event = geminiErrorEvent(error)
    expect(event.code).toBe('context_too_long')
    expect(event.message).not.toMatch(LEAK)
  })

  it('bridge runtimes: Claude Code "Prompt is too long", Codex contextWindowExceeded', () => {
    for (const [value, wording] of [
      [new Error('Prompt is too long'), CLAUDE_FAILURES],
      [{ type: 'result', subtype: 'error', result: 'Prompt is too long' }, CLAUDE_FAILURES],
      [{ codexErrorInfo: 'contextWindowExceeded', message: 'sk-secret' }, CODEX_FAILURES],
      [{ error: { message: 'Input exceeds the context window' } }, CODEX_FAILURES],
    ] as const) {
      const failure = mapFailure(value, wording)
      expect(failure.code).toBe('context_too_long')
      expect(failure.message).not.toMatch(LEAK)
    }
  })
})

describe('the agent loop refuses a history over a known context window', () => {
  const client = (): AgentClient & { calls: number } => {
    const fake = {
      calls: 0,
      messages: {
        stream: vi.fn(() => {
          fake.calls += 1
          throw new Error('must not be called')
        }),
      },
    }
    return fake
  }
  const run = async (contextWindow: number | undefined, history: MessageParam[]) => {
    const fake = client()
    const events: AgentEvent[] = []
    const agent = createAgent({
      client: fake,
      tools: [],
      model: 'small-model',
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    })
    const result = await agent.run(history, {
      signal: new AbortController().signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: (event) => events.push(event),
    })
    return { result, events, calls: fake.calls }
  }
  const long: MessageParam[] = [{ role: 'user', content: 'x'.repeat(60_000) }]

  it('never sends it, never cuts it, and says so naming the model', async () => {
    const { result, events, calls } = await run(4_096, long)
    expect(calls).toBe(0)
    expect(result.stopReason).toBe('context_too_long')
    expect(result.conversation).toEqual(long)
    expect(events).toContainEqual({
      type: 'error',
      code: 'context_too_long',
      message: contextTooLongMessage('small-model'),
    })
  })

  it('sends it when it fits, or when no window is known', async () => {
    expect((await run(1_000_000, long)).calls).toBe(1)
    expect((await run(undefined, long)).calls).toBe(1)
  })

  it('estimates low: images count a fixed amount, text about 5 characters a token', () => {
    // The role and other strings count too.
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(5_000) }])).toBe(1_001)
    const image: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1e6) },
        },
      ],
    }
    expect(estimateTokens([image])).toBeLessThan(2_000)
    expect(contextWindowOf(128_000)).toBe(128_000)
    expect([
      contextWindowOf(0),
      contextWindowOf(-1),
      contextWindowOf('9'),
      contextWindowOf(1.5),
    ]).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('a model list’s context window reaches the agent loop', () => {
  it('uses the window the last list gave, without a request of its own', async () => {
    const { modelApiAdapter } = await import('../providers/adapters/model-api')
    const stream = vi.fn(() => {
      throw new Error('must not be called')
    })
    const list = vi.fn(() => Promise.resolve([{ id: 'tiny', label: 'Tiny', contextWindow: 1_000 }]))
    const adapter = modelApiAdapter({
      id: 'lmstudio',
      vendor: 'local',
      access: 'free',
      label: 'Test · Local',
      shortLabel: 'Test',
      title: 'Test',
      description: 'Test',
      capabilities: {
        authKind: 'local',
        listsModels: true,
        reportsUsage: false,
        needsRuntime: false,
      },
      personalUseOnly: false,
      pickerOrder: 9,
      client: () => ({ messages: { stream } }),
      list,
      listsContextWindow: true,
      recommended: ['tiny'],
      errorEvent: openAICompatErrorEvent,
      readyMessage: () => 'Ready.',
      missingKeyMessage: 'No key.',
      noModelsMessage: 'No models.',
    })({
      userData: '',
      openUrl: () => Promise.resolve(),
      settings: undefined,
      keys: undefined,
      loginTimeout: undefined,
      context: () => Promise.reject(new Error('no runtime')),
      track: () => ({ signal: new AbortController().signal, done: () => {} }),
    })
    await adapter.models?.()
    expect(list).toHaveBeenCalledOnce()
    const runner = await adapter.runner([])
    expect(list).toHaveBeenCalledOnce()
    const result = await runner.run([{ role: 'user', content: 'x'.repeat(20_000) }], {
      signal: new AbortController().signal,
      requestApproval: () => Promise.resolve(false),
      onEvent: () => {},
    })
    expect(result.stopReason).toBe('context_too_long')
    expect(stream).not.toHaveBeenCalled()
  })
})
