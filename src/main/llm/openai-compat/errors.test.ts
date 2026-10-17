import { describe, expect, it } from 'vitest'
import { retryAt } from './errors'

describe('retryAt', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  it.each([
    [{ 'retry-after-ms': '1500' }, '2026-10-17T12:00:01.500Z'],
    [{ 'retry-after': '20' }, '2026-10-17T12:00:20.000Z'],
    [{ 'retry-after': 'Sat, 17 Oct 2026 12:05:00 GMT' }, '2026-10-17T12:05:00.000Z'],
    [
      { 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' },
      '2026-10-17T12:06:00.000Z',
    ],
    [{ 'x-ratelimit-reset-tokens': '250ms' }, '2026-10-17T12:00:00.250Z'],
    [{ 'x-ratelimit-reset-tokens': 'soon' }, undefined],
    [{}, undefined],
  ])('reads %j', (headers, expected) => {
    expect(retryAt(new Headers(headers), now)).toBe(expected)
  })
})
