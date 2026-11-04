import { describe, expect, it } from 'vitest'
import { isWebLink, webLinkHref } from './web-link-rule'

describe('the web link rule', () => {
  it.each([
    ['https://example.com/a?b#c', 'https://example.com/a?b#c'],
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://Example.COM/Path', 'https://example.com/Path'],
    ['HtTp://example.com/', 'http://example.com/'],
    ['https://user:pw@example.com/', 'https://user:pw@example.com/'],
    ['https://exаmple.com/', 'https://xn--exmple-4nf.com/'],
  ])('accepts %s and opens its parsed form', (input, href) => {
    expect(isWebLink(input)).toBe(true)
    expect(webLinkHref(input)).toBe(href)
  })

  it('keeps credentials in the URL attached to the host that follows the @', () => {
    expect(webLinkHref('https://example.com@evil.test/')).toBe('https://example.com@evil.test/')
  })

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,hi',
    'file:///C:/Windows/System32/calc.exe',
    'ftp://example.com/',
    'mailto:a@example.com',
    'vbscript:x',
    'https:example.com',
    'https:\\\\example.com',
    '//example.com',
    'example.com',
    '',
  ])('rejects the other scheme or shape %j', (input) => {
    expect(isWebLink(input)).toBe(false)
  })

  it.each([
    ' https://example.com',
    'https://example.com ',
    '\thttps://example.com',
    'https://example.com\n',
    'https://exa mple.com/',
    'https://example.com/a b',
    'https://example.com/\u0000',
    '\u00a0https://example.com',
    'https://example.com/\u0085',
  ])('rejects whitespace and control characters in %j', (input) => {
    expect(isWebLink(input)).toBe(false)
  })

  it.each(['https://', 'http://[', 'https://[::1', 'https://:80/', 'http://%zz/', 'https://a b'])(
    'rejects malformed %j',
    (input) => {
      expect(isWebLink(input)).toBe(false)
    },
  )

  it('opens a direction character only in its percent-encoded form', () => {
    expect(webLinkHref('https://example.com/a\u202eb')).toBe('https://example.com/a%E2%80%AEb')
  })
})
