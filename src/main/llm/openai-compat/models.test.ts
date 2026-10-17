import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listOpenAICompatModels, validateOpenAICompatKey } from './models'
import { fakeServer, json, redirectFetch, type FakeServer } from './test-support'

let server: FakeServer
beforeEach(async () => {
  server = await fakeServer()
})
afterEach(async () => {
  await server.close()
})
const KEY = 'sk-test-SECRET-0123456789'

describe('listOpenAICompatModels', () => {
  it('lists every local model with unknown tool support', async () => {
    server.reply(
      json(200, {
        object: 'list',
        data: [
          { id: 'qwen3:8b', object: 'model', owned_by: 'library' },
          { id: 'llama3.2:latest', object: 'model' },
          { id: 'qwen3:8b' },
          { object: 'model' },
        ],
      }),
    )
    const models = await listOpenAICompatModels({ baseUrl: server.baseUrl, flavor: 'ollama' })
    expect(models).toEqual([
      { id: 'llama3.2:latest', toolSupport: 'unknown' },
      { id: 'qwen3:8b', toolSupport: 'unknown' },
    ])
    expect(server.requests).toMatchObject([{ method: 'GET', path: '/v1/models' }])
    expect(server.requests[0]?.headers.authorization).toBeUndefined()
  })

  it('keeps only OpenRouter models that support tools', async () => {
    const seen: string[] = []
    server.reply(
      json(200, {
        data: [
          {
            id: 'a/tools',
            name: 'A',
            context_length: 128000,
            supported_parameters: ['tools', 'tool_choice'],
          },
          { id: 'b/no-tools', name: 'B', supported_parameters: ['temperature'] },
          { id: 'c/unknown' },
        ],
      }),
    )
    const models = await listOpenAICompatModels({
      baseUrl: 'https://openrouter.ai/api/v1',
      flavor: 'openrouter',
      apiKey: KEY,
      fetch: redirectFetch(server.origin, seen),
    })
    expect(models).toEqual([
      { id: 'a/tools', name: 'A', contextLength: 128000, toolSupport: 'supported' },
    ])
    expect(seen).toEqual(['https://openrouter.ai/api/v1/models'])
  })

  it('drops OpenAI models that cannot chat', async () => {
    server.reply(
      json(200, {
        data: [
          'gpt-5',
          'text-embedding-3-small',
          'whisper-1',
          'gpt-4o-transcribe',
          'dall-e-3',
          'o4-mini',
        ].map((id) => ({ id, object: 'model' })),
      }),
    )
    const models = await listOpenAICompatModels({
      baseUrl: 'https://api.openai.com/v1',
      flavor: 'openai',
      apiKey: KEY,
      fetch: redirectFetch(server.origin),
    })
    expect(models.map((m) => m.id)).toEqual(['gpt-5', 'o4-mini'])
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('maps failures without the key', async () => {
    server.reply(json(401, { error: { message: `Incorrect API key provided: ${KEY}` } }))
    const error: unknown = await listOpenAICompatModels({
      baseUrl: server.baseUrl,
      flavor: 'lmstudio',
      apiKey: KEY,
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'authentication' })
    expect(String(error) + JSON.stringify(error)).not.toContain(KEY)
  })
})

describe('validateOpenAICompatKey', () => {
  it('checks the key against /models only', async () => {
    server.reply(json(200, { data: [] }))
    const options = {
      baseUrl: 'https://api.openai.com/v1',
      flavor: 'openai' as const,
      apiKey: KEY,
      fetch: redirectFetch(server.origin),
    }
    expect(await validateOpenAICompatKey(options)).toEqual({ ok: true })
    server.reply(json(401, { error: { message: `Incorrect API key provided: ${KEY}` } }))
    const result = await validateOpenAICompatKey(options)
    expect(result).toMatchObject({ ok: false, code: 'authentication' })
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/models',
      'GET /v1/models',
    ])
  })

  it('uses /key for OpenRouter, whose model list accepts any key', async () => {
    server.reply(json(401, { error: { message: 'User not found.', code: 401 } }))
    const result = await validateOpenAICompatKey({
      baseUrl: 'https://openrouter.ai/api/v1',
      flavor: 'openrouter',
      apiKey: KEY,
      fetch: redirectFetch(server.origin),
    })
    expect(result).toMatchObject({ ok: false, code: 'authentication' })
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/key'])
  })

  it('reports a missing key and a rejected base URL without a request', async () => {
    expect(
      await validateOpenAICompatKey({ baseUrl: 'https://api.openai.com/v1', flavor: 'openai' }),
    ).toMatchObject({ ok: false, code: 'authentication' })
    expect(
      await validateOpenAICompatKey({ baseUrl: 'http://10.0.0.5:11434', flavor: 'ollama' }),
    ).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(server.requests).toHaveLength(0)
  })
})
