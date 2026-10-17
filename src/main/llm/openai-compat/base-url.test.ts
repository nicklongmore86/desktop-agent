import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_URLS, resolveBaseUrl, type OpenAICompatFlavor } from './base-url'

const href = (url: string, flavor: OpenAICompatFlavor) => resolveBaseUrl(url, flavor).href

describe('resolveBaseUrl', () => {
  it.each([
    ['https://api.openai.com/v1', 'openai', 'https://api.openai.com/v1'],
    ['https://api.openai.com', 'openai', 'https://api.openai.com/v1'],
    ['https://openrouter.ai/api/v1/', 'openrouter', 'https://openrouter.ai/api/v1'],
    ['https://openrouter.ai', 'openrouter', 'https://openrouter.ai/api/v1'],
    ['http://localhost:11434', 'ollama', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:11434/v1', 'ollama', 'http://127.0.0.1:11434/v1'],
    ['http://[::1]:1234/v1', 'lmstudio', 'http://[::1]:1234/v1'],
    ['http://LOCALHOST:1234/v1', 'lmstudio', 'http://localhost:1234/v1'],
  ] as const)('accepts %s for %s', (url, flavor, expected) => {
    expect(href(url, flavor)).toBe(expected)
  })

  it('accepts every default', () => {
    for (const [flavor, url] of Object.entries(DEFAULT_BASE_URLS))
      expect(href(url, flavor as OpenAICompatFlavor)).toBe(url)
  })

  it.each([
    ['http://api.openai.com/v1', 'openai', /https is required/],
    ['https://api.openai.com.evil.test/v1', 'openai', /only api.openai.com/],
    ['https://evil.test/v1', 'openai', /only api.openai.com/],
    ['https://api.openai.com:8443/v1', 'openai', /only api.openai.com/],
    ['https://openrouter.ai.evil.test/api/v1', 'openrouter', /only openrouter.ai/],
    ['https://api.openai.com/v1', 'openrouter', /only openrouter.ai/],
    ['https://user:pw@api.openai.com/v1', 'openai', /credentials/],
    ['https://api.openai.com/v1?x=1', 'openai', /query/],
    ['https://localhost:11434/v1', 'ollama', /http:\/\//],
    ['http://192.168.1.10:11434/v1', 'ollama', /only 127.0.0.1/],
    ['http://0.0.0.0:11434/v1', 'ollama', /only 127.0.0.1/],
    ['http://localhost.evil.test:1234/v1', 'lmstudio', /only 127.0.0.1/],
    ['http://127.0.0.2:1234/v1', 'lmstudio', /only 127.0.0.1/],
    ['file:///etc/passwd', 'lmstudio', /http:\/\//],
    ['not a url', 'ollama', /not a valid URL/],
  ] as const)('rejects %s for %s', (url, flavor, why) => {
    expect(() => resolveBaseUrl(url, flavor)).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        message: expect.stringMatching(why) as unknown,
      }),
    )
  })

  it('never echoes the rejected URL', () => {
    expect(() => resolveBaseUrl('https://sk-secret@evil.test/v1', 'openai')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('sk-secret') as unknown }),
    )
  })
})
