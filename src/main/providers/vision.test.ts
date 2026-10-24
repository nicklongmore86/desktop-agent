import { describe, expect, it } from 'vitest'
import { geminiVision, NO_VISION, openAIVision, resolveVision } from './vision'

describe('vision rules', () => {
  it('knows the documented OpenAI models that read images and those that do not', () => {
    for (const id of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4o-2024-08-06',
      'gpt-4.1',
      'gpt-4.1-nano',
      'gpt-4-turbo',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'o1',
      'o3',
      'o3-pro',
      'o4-mini',
      'chatgpt-4o-latest',
      'codex-mini-latest',
      'GPT-4O',
    ])
      expect([id, openAIVision(id)]).toEqual([id, true])
    for (const id of [
      'gpt-3.5-turbo',
      'gpt-4',
      'gpt-4-0613',
      'gpt-4-1106-preview',
      'o1-mini',
      'o3-mini',
      'gpt-oss-120b',
    ])
      expect([id, openAIVision(id)]).toEqual([id, false])
    for (const id of ['ft:custom', 'davinci-002', 'my-model'])
      expect([id, openAIVision(id)]).toEqual([id, null])
  })

  it('does not take a lookalike or an unlisted variant of a family to read images', () => {
    for (const id of [
      'codex-mini',
      'codex-mini-evil',
      'codex-mini-latest-text',
      'gpt-4o-text',
      'gpt-4o-transcribe',
      'gpt-4o-audio-preview',
      'gpt-4o-mini-tts',
      'gpt-4.1-evil',
      'gpt-5-text',
      'gpt-5.6-terra',
      'o3-deep',
      'o1x',
      'o4-mini-high-evil',
      'gpt-4o\nx',
      'xgpt-4o',
    ])
      expect([id, openAIVision(id)]).toEqual([id, null])
  })

  it('knows the Gemini families', () => {
    for (const id of [
      'gemini-2.5-flash',
      'models/gemini-3-pro-preview',
      'gemini-flash-latest',
      'gemini-1.5-pro-002',
      'gemini-2.5-flash-preview-05-20',
      'gemini-2.5-flash-image',
    ])
      expect([id, geminiVision(id)]).toEqual([id, true])
    expect(geminiVision('gemini-1.0-pro')).toBe(false)
    for (const id of [
      'gemma-3-27b-it',
      'gemini-2.5-flash-preview-tts',
      'gemini-embedding-001',
      'gemini-2.5-flash-evil',
      'gemini-2-text',
    ])
      expect([id, geminiVision(id)]).toEqual([id, null])
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
