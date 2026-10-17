import { describe, expect, it } from 'vitest'
import { plainText } from './plain-text'

const chars = (...codes: number[]): string => String.fromCodePoint(...codes)

describe('plainText', () => {
  it('removes bidi, zero-width and control characters', () => {
    const RLO = chars(0x202e)
    const LRI = chars(0x2066)
    const ZWSP = chars(0x200b)
    const BEL = chars(7)
    expect(plainText('gpt' + RLO + '-4' + LRI + 'o' + ZWSP + BEL + ' mini')).toBe('gpt-4o mini')
    expect(plainText('a' + chars(0x61c) + 'b' + chars(0xfeff) + 'c' + chars(0xad) + 'd')).toBe(
      'abcd',
    )
  })

  it('removes the other format characters: word joiner range, Mongolian selector, tags, fillers', () => {
    expect(plainText('a' + chars(0x2060, 0x2064, 0x206f) + 'b')).toBe('ab')
    expect(plainText('a' + chars(0x180e) + 'b')).toBe('ab')
    // Tag characters can smuggle text that does not show: U+E0041 is an invisible "A".
    expect(plainText('ok' + chars(0xe0041, 0xe0042, 0xe007f))).toBe('ok')
    expect(plainText('x' + chars(0x3164, 0x115f, 0xffa0) + 'y')).toBe('xy')
    expect(plainText('a' + chars(0x200d) + 'b')).toBe('ab')
    expect(plainText(chars(0x200d) + 'a')).toBe('a')
  })

  it('keeps variation selectors and a joiner between two emoji', () => {
    const heart = chars(0x2764, 0xfe0f)
    expect(plainText('I ' + heart + ' local models')).toBe('I ' + heart + ' local models')
    const family = chars(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    expect(plainText('Team ' + family)).toBe('Team ' + family)
    const couple = chars(0x1f469, 0xfe0f, 0x200d, 0x2764, 0xfe0f)
    expect(plainText(couple + 'x')).toBe(couple + 'x')
    expect(plainText('1' + chars(0xfe0f, 0x20e3))).toBe('1' + chars(0xfe0f, 0x20e3))
    // Not between two emoji: a joiner after text or at the end is removed.
    expect(plainText(chars(0x1f468, 0x200d) + 'a')).toBe(chars(0x1f468) + 'a')
  })

  it('turns line breaks into spaces and leaves ordinary text alone', () => {
    expect(plainText('Not running.\nStart it,\r\nthen check again.')).toBe(
      'Not running. Start it, then check again.',
    )
    expect(plainText('qwen3:8b · Ünïcode 日本語')).toBe('qwen3:8b · Ünïcode 日本語')
  })
})
