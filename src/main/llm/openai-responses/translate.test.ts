import { describe, expect, it } from 'vitest'
import { assertAllowedBody, OMITTED_BODY_KEYS } from './translate'

describe('assertAllowedBody', () => {
  it.each(OMITTED_BODY_KEYS)('refuses a body with %s', (key) => {
    expect(() => {
      assertAllowedBody({ model: 'm', input: [], store: false, stream: true, [key]: 1 })
    }).toThrow(expect.objectContaining({ code: 'invalid_request' }))
  })

  it('accepts the fields this client sends', () => {
    expect(() => {
      assertAllowedBody({
        model: 'm',
        instructions: 'i',
        input: [],
        tools: [],
        store: false,
        stream: true,
      })
    }).not.toThrow()
  })
})
