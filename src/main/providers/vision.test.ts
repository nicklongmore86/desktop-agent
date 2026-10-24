import { describe, expect, it } from 'vitest'
import { geminiVision, NO_VISION, openAIVision, resolveVision } from './vision'

describe('vision rules', () => {
  it('knows the OpenAI families that read images and those that do not', () => {
    for (const id of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4-turbo',
      'gpt-5',
      'gpt-5.1-codex',
      'gpt-6.1-sol',
      'o3',
      'o4-mini',
      'chatgpt-4o-latest',
    ])
      expect([id, openAIVision(id)]).toEqual([id, true])
    for (const id of ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-0613', 'o1-mini', 'o3-mini', 'gpt-oss-120b'])
      expect([id, openAIVision(id)]).toEqual([id, false])
    for (const id of ['ft:custom', 'davinci-002', 'my-model'])
      expect([id, openAIVision(id)]).toEqual([id, null])
  })

  it('knows the Gemini families', () => {
    expect(geminiVision('gemini-2.5-flash')).toBe(true)
    expect(geminiVision('models/gemini-3-pro-preview')).toBe(true)
    expect(geminiVision('gemini-flash-latest')).toBe(true)
    expect(geminiVision('gemini-1.0-pro')).toBe(false)
    expect(geminiVision('gemma-3-27b-it')).toBeNull()
  })

  it('lets the setting decide only when nothing else says, and only where it is offered', () => {
    const options = { source: 'model' as const, configurable: true, setting: true }
    expect(resolveVision(false, options)).toMatchObject({ enabled: false, source: 'model' })
    expect(resolveVision(null, options)).toMatchObject({ enabled: true, source: 'setting' })
    expect(resolveVision(null, { ...options, setting: false })).toMatchObject({ enabled: false })
    expect(resolveVision(null, { ...options, configurable: false })).toMatchObject({
      enabled: false,
    })
    expect(NO_VISION.enabled).toBe(false)
  })
})
