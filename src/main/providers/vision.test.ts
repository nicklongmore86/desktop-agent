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

  // One row per rule in vision.ts, each with the documented ids it must accept, so a rule
  // that stops matching (a mis-escaped `\\.` or `\\d`, a lost anchor) fails here by name.
  const RULES: [rule: string, vision: (id: string) => boolean | null, ids: string[]][] = [
    ['chatgpt-4o-latest', openAIVision, ['chatgpt-4o-latest']],
    [
      'gpt-4o',
      openAIVision,
      ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18'],
    ],
    ['gpt-4.1', openAIVision, ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.1-2025-04-14']],
    ['gpt-4.5', openAIVision, ['gpt-4.5-preview', 'gpt-4.5-preview-2025-02-27']],
    ['gpt-4-turbo', openAIVision, ['gpt-4-turbo', 'gpt-4-turbo-2024-04-09']],
    ['gpt-4-vision-preview', openAIVision, ['gpt-4-vision-preview']],
    [
      'gpt-5+',
      openAIVision,
      [
        'gpt-5',
        'gpt-5.1',
        'gpt-5-mini',
        'gpt-5-nano',
        'gpt-5-2025-08-07',
        'gpt-5.1-codex-mini',
        'gpt-10.12-pro',
      ],
    ],
    ['o1', openAIVision, ['o1', 'o1-pro', 'o1-2024-12-17']],
    ['o3', openAIVision, ['o3', 'o3-pro', 'o3-2025-04-16']],
    ['o4-mini', openAIVision, ['o4-mini', 'o4-mini-2025-04-16']],
    ['codex-mini-latest', openAIVision, ['codex-mini-latest']],
    [
      'gemini numbered',
      geminiVision,
      [
        'gemini-1.5-pro',
        'gemini-1.5-pro-002',
        'gemini-1.5-flash-8b',
        'gemini-2.0-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.5-flash-preview-05-20',
        'gemini-2.0-flash-exp',
        'gemini-3-pro',
        'gemini-3-pro-preview',
        'gemini-3.1-flash-image-preview',
      ],
    ],
    [
      'gemini aliases',
      geminiVision,
      ['gemini-pro-latest', 'gemini-flash-lite-latest', 'models/Gemini-2.5-Flash', 'GEMINI-3-PRO'],
    ],
    ['gemini-exp', geminiVision, ['gemini-exp-1206']],
    [
      'gemini pro vision',
      geminiVision,
      ['gemini-1.0-pro-vision', 'gemini-1.0-pro-vision-001', 'gemini-pro-vision'],
    ],
  ]
  // One row per text-only rule, with the documented ids it must refuse.
  const BLIND: [rule: string, vision: (id: string) => boolean | null, ids: string[]][] = [
    [
      'gpt-3.5',
      openAIVision,
      ['gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-3.5-turbo-16k', 'gpt-3.5-turbo-instruct'],
    ],
    ['gpt-4', openAIVision, ['gpt-4', 'gpt-4-0613', 'gpt-4-32k', 'gpt-4-32k-0613']],
    [
      'gpt-4 previews',
      openAIVision,
      ['gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-4-turbo-preview'],
    ],
    ['o1-mini/preview', openAIVision, ['o1-mini', 'o1-preview', 'o1-mini-2024-09-12']],
    ['o3-mini', openAIVision, ['o3-mini', 'o3-mini-2025-01-31']],
    ['gpt-oss', openAIVision, ['gpt-oss-20b', 'gpt-oss-120b']],
    [
      'gemini 1.0',
      geminiVision,
      ['gemini-1.0-pro', 'gemini-1.0-pro-001', 'gemini-1.0-pro-latest', 'gemini-1.0-ultra'],
    ],
  ]

  it.each(RULES)('reads images: %s', (_rule, vision, ids) => {
    for (const id of ids) expect([id, vision(id)]).toEqual([id, true])
  })

  it.each(BLIND)('does not read images: %s', (_rule, vision, ids) => {
    for (const id of ids) expect([id, vision(id)]).toEqual([id, false])
  })

  it.each([
    ...[
      'codex-mini',
      'codex-mini-evil',
      'gpt-4o-text',
      'gpt-4o-transcribe',
      'gpt-4o-audio-preview',
    ],
    ...['gpt-4\\.1', 'gpt-4x1', 'gpt-401', 'gpt-4.1x', 'GPT-4o ', ' gpt-4o', 'gpt-4o\n', '-gpt-4o'],
    ...['gpt-4\u20241', 'gpt-4\uff0e1', 'gpt-\uff14o', 'gpt-4.\u0661', 'gpt-\u0665', 'o\u0663'],
    ...[
      'gpt-4o-2024-8-06',
      'gpt-4o-20240806',
      'gpt-5..1',
      'gpt-5.123',
      'gpt-4-turbo-preview-x',
      ...['gpt-4x5-preview', 'gpt-5x1', 'gpt-3x5-turbo', 'gpt-4-turbo-2024x04-09'],
    ],
  ])('says nothing of the OpenAI lookalike %j', (id) => {
    expect(openAIVision(id)).toBeNull()
  })

  it.each([
    ...['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-native-audio', 'gemini-1.5-pro\n'],
    ...['gemini-1\\.5-pro', 'gemini-105-pro', 'gemini-1.5-pro ', 'xgemini-1.5-pro', 'gemini-pro'],
    ...[
      'gemini-1\uff0e5-pro',
      'gemini-\uff11.5-pro',
      'gemini-2.\u0665-flash',
      'gemini-1x0-pro-vision',
      'gemini-2x5-flash',
    ],
  ])('says nothing of the Gemini lookalike %j', (id) => {
    expect(geminiVision(id)).toBeNull()
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
