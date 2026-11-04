import { describe, expect, it } from 'vitest'
import {
  displayUrl,
  linkMismatch,
  misleadingHost,
  plainDestination,
  webDestination,
} from './web-link-mismatch'

describe('webDestination', () => {
  it('reads the host the browser would connect to', () => {
    expect(webDestination('https://Example.COM:8443/a?b#c')).toEqual({ host: 'example.com' })
    expect(webDestination('http://user:pw@evil.test/')).toEqual({ host: 'evil.test' })
    expect(webDestination('https://exаmple.com/')).toEqual({ host: 'xn--exmple-4nf.com' })
  })
  it('is null for anything but http(s)', () => {
    for (const href of ['mailto:a@b.c', 'docs/a.md', '#top', 'ftp://x.test', 'https://', ''])
      expect(webDestination(href)).toBeNull()
  })
})

describe('misleadingHost', () => {
  it.each([
    ['https://example.com', 'evil.test', 'example.com'],
    ['example.com', 'evil.test', 'example.com'],
    ['www.example.com/login', 'evil.test', 'www.example.com'],
    ['Go to example.com now', 'evil.test', 'example.com'],
    ['(https://example.com/a).', 'evil.test', 'example.com'],
    ['1.2.3.4', 'evil.test', '1.2.3.4'],
    // A look-alike letter: the text reads as example.com, the link goes to the punycode host.
    ['example.com', 'xn--exmple-4nf.com', 'example.com'],
    ['exаmple.com', 'example.com', 'xn--exmple-4nf.com'],
    ['https://example.com@evil.test', 'example.com', 'evil.test'],
  ])('flags %j going to %s', (text, real, claimed) => {
    expect(misleadingHost(text, real)).toBe(claimed)
  })

  it.each([
    ['https://example.com/docs', 'example.com'],
    ['www.example.com', 'example.com'],
    ['example.com', 'www.example.com'],
    ['EXAMPLE.com', 'example.com'],
    ['Read the docs', 'example.com'],
    ['README.md', 'github.com'],
    ['notes.txt', 'example.com'],
    ['v1.2.3', 'example.com'],
    ['e.g. this', 'example.com'],
    ['click here', 'evil.test'],
    ['', 'evil.test'],
  ])('does not flag %j going to %s', (text, real) => {
    expect(misleadingHost(text, real)).toBeNull()
  })
})

describe('displayUrl', () => {
  it('turns encoded non-ASCII characters back, and nothing else', () => {
    expect(displayUrl('https://ex%D0%B0mple.com/a%E2%80%AEb')).toBe('https://exаmple.com/a\u202Eb')
    expect(displayUrl('https://a.test/%2F%3F%20%25')).toBe('https://a.test/%2F%3F%20%25')
    expect(displayUrl('https://a.test/%E2%80')).toBe('https://a.test/%E2%80')
  })
})

describe('linkMismatch', () => {
  it('names the claimed and the real host when the text claims another site', () => {
    expect(linkMismatch('https://paypal.com', 'https://evil.test/x')).toEqual({
      claimed: 'paypal.com',
      host: 'evil.test',
    })
    expect(linkMismatch('www.example.com', 'https://example.com/a')).toBeNull()
    expect(linkMismatch('README.md', 'https://evil.test/')).toBeNull()
    expect(linkMismatch('https://paypal.com', 'mailto:a@b.test')).toBeNull()
  })
})

describe('plainDestination', () => {
  it('shows only printable ASCII: punycode hosts, encoded paths, tokens for anything else', () => {
    expect(plainDestination('https://exаmple.com/a‮b')).toBe(
      'https://xn--exmple-4nf.com/a%E2%80%AEb',
    )
    expect(plainDestination('not a url ‮​')).toBe('not a url ⟨U+202E⟩⟨U+200B⟩')
    expect(plainDestination(`https://a.test/${'x'.repeat(500)}`).length).toBe(401)
  })
})
