import { describe, expect, it } from 'vitest'
import { plainText } from './plain-text'

const chars = (...codes: number[]): string => String.fromCharCode(...codes)

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
  it('turns line breaks into spaces and leaves ordinary text alone', () => {
    expect(plainText('Not running.\nStart it,\r\nthen check again.')).toBe(
      'Not running. Start it, then check again.',
    )
    expect(plainText('qwen3:8b · Ünïcode 日本語')).toBe('qwen3:8b · Ünïcode 日本語')
  })
})
