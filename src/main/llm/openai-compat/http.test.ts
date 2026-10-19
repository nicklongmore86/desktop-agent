import { describe, expect, it } from 'vitest'
import { readText, sharesSecret } from './http'

const body = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })

describe('readText', () => {
  it('returns a body up to the limit whole', async () => {
    expect(await readText(body('{"a":', '1}'), 7)).toEqual({ ok: true, text: '{"a":1}' })
    expect(await readText(body(''), 7)).toEqual({ ok: true, text: '' })
  })

  it('refuses a body past the limit, even when its first bytes are valid JSON', async () => {
    // One chunk: valid JSON within the limit, then bytes past it.
    expect(await readText(body(`{"a":1}${' '.repeat(10)}`), 12)).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(await readText(body('{"a":1}', '   ', '   '), 12)).toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  it('reports an unreadable body', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket'))
      },
    })
    expect(await readText(failing, 10)).toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('sharesSecret', () => {
  const secret = 'eyJhbGciOi.SECRET-access-token-0123456789.sig'
  it.each([
    [secret, true],
    [`x ${secret} y`, true],
    [secret.toLowerCase(), true],
    ['token-0123', true],
    ['access-t', true],
    ['access', false],
    ['invalid_value', false],
    ['req_abc123', false],
  ])('%j -> %s', (value, expected) => {
    expect(sharesSecret(value, secret)).toBe(expected)
  })

  it('is false without a secret', () => {
    expect(sharesSecret('anything', undefined)).toBe(false)
  })
})
