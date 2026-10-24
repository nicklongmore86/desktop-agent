import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import { jpegShell, pngShell } from '../documents/fixtures.test-util'
import type { ToolImage } from '../tools/types'
import {
  checkToolImages,
  hasImages,
  IMAGE_BUDGET,
  imageBlock,
  isSendableImage,
  NO_VISION_NOTE,
  safeLabel,
  savedToolText,
  toolResultImages,
  withImageBudget,
  type LiveToolImages,
} from './images'

const png = (label?: string): ToolImage => ({
  mime: 'image/png',
  data: pngShell(8, 4),
  width: 8,
  height: 4,
  ...(label === undefined ? {} : { label }),
})

describe('isSendableImage', () => {
  it('accepts PNG, JPEG, GIF and WebP whose bytes match the claimed type', () => {
    expect(isSendableImage(pngShell(2, 2), 'image/png')).toBe(true)
    expect(isSendableImage(jpegShell(3, 5), 'image/jpeg', { width: 3, height: 5 })).toBe(true)
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 4, 0, 0, 0, 0])
    expect(isSendableImage(gif, 'image/gif')).toBe(true)
  })

  it('refuses a mismatched type, wrong dimensions, empty or oversized bytes and other formats', () => {
    expect(isSendableImage(pngShell(2, 2), 'image/jpeg')).toBe(false)
    expect(isSendableImage(jpegShell(3, 5), 'image/jpeg', { width: 5, height: 3 })).toBe(false)
    expect(isSendableImage(new Uint8Array(), 'image/png')).toBe(false)
    expect(isSendableImage(pngShell(0, 2), 'image/png')).toBe(false)
    const big = new Uint8Array(IMAGE_BUDGET.maxBytes + 1)
    big.set(pngShell(2, 2))
    expect(isSendableImage(big, 'image/png')).toBe(false)
    expect(isSendableImage(pngShell(2, 2), 'image/tiff')).toBe(false)
    expect(isSendableImage('not bytes' as unknown as Uint8Array, 'image/png')).toBe(false)
  })
})

describe('safeLabel', () => {
  it('keeps short plain labels and falls back for paths, URLs and tokens', () => {
    expect(safeLabel('page 3', 0)).toBe('page 3')
    expect(safeLabel('  page   3 (region)  ', 0)).toBe('page 3 (region)')
    expect(safeLabel(undefined, 1)).toBe('image 2')
    expect(safeLabel('C:\\Users\\me\\scan.png', 0)).toBe('image 1')
    expect(safeLabel('/home/me/.ssh/id_rsa', 0)).toBe('image 1')
    expect(safeLabel('https://example.test/a', 0)).toBe('image 1')
    expect(safeLabel('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 0)).toBe('image 1')
    expect(safeLabel('x'.repeat(61), 0)).toBe('image 1')
    expect(safeLabel('page\n3', 0)).toBe('page 3')
    expect(safeLabel('\u202Epage', 0)).toBe('image 1')
  })
})

describe('checkToolImages and savedToolText', () => {
  it('keeps valid images with safe labels and counts the others', () => {
    const checked = checkToolImages([
      png('page 1'),
      { ...png('page 2'), width: 9 },
      { ...png('page 3'), mime: 'image/webp' as 'image/png' },
      png('/etc/passwd'),
    ])
    expect(checked.images.map((image) => image.label)).toEqual(['page 1', 'image 4'])
    expect(checked.dropped).toBe(2)
    expect(checked.images[0]?.block).toEqual(imageBlock('image/png', pngShell(8, 4)))
  })

  it('takes at most IMAGE_BUDGET.maxImages from one result', () => {
    const checked = checkToolImages(Array.from({ length: 25 }, () => png()))
    expect(checked.images).toHaveLength(IMAGE_BUDGET.maxImages)
    expect(checked.dropped).toBe(5)
  })

  it('saves a note naming the images, never their bytes', () => {
    const checked = checkToolImages([png('page 1'), png('page 2')])
    const saved = savedToolText('Two pages.', checked, true)
    expect(saved).toBe(
      'Two pages.\n\n[2 images shown with this result (page 1, page 2). Images are not kept in the conversation; call the tool again to see them.]',
    )
    expect(savedToolText('Two pages.', checked, false)).toContain(NO_VISION_NOTE)
    expect(savedToolText('x', { images: [], dropped: 1 }, true)).toContain('1 image dropped')
    expect(savedToolText('plain', { images: [], dropped: 0 }, true)).toBe('plain')
    expect(saved).not.toContain(Buffer.from(pngShell(8, 4)).toString('base64'))
  })

  it('keeps the images live only with vision', () => {
    expect(toolResultImages({ content: 'x', images: [png()] }, true).live?.images).toHaveLength(1)
    expect(toolResultImages({ content: 'x', images: [png()] }, false).live).toBeNull()
    expect(toolResultImages({ content: 'x' }, true)).toEqual({ text: 'x', live: null })
  })
})

const step = (id: string): MessageParam[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `saved ${id}` }] },
]
const liveFor = (count: number, content = 'pages'): LiveToolImages => ({
  content,
  images: checkToolImages(Array.from({ length: count }, (_, i) => png(`page ${String(i + 1)}`)))
    .images,
})
const imagesIn = (message: MessageParam | undefined): number =>
  typeof message?.content === 'string' || !message
    ? 0
    : message.content.reduce(
        (sum, block) =>
          sum +
          (block.type === 'image'
            ? 1
            : block.type === 'tool_result' && Array.isArray(block.content)
              ? block.content.filter((part) => part.type === 'image').length
              : 0),
        0,
      )

describe('withImageBudget', () => {
  it('resends tool images from the last two tool steps only', () => {
    const history: MessageParam[] = [
      { role: 'user', content: 'Go' },
      ...step('a'),
      ...step('b'),
      ...step('c'),
    ]
    const live = new Map([
      ['a', liveFor(1)],
      ['b', liveFor(2)],
      ['c', liveFor(1)],
    ])
    const before = structuredClone(history)
    const out = withImageBudget(history, live, true)
    expect(history).toEqual(before)
    expect(out[2]).toBe(history[2])
    expect(imagesIn(out[2])).toBe(0)
    expect(imagesIn(out[4])).toBe(2)
    expect(imagesIn(out[6])).toBe(1)
    expect(out[4]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'b',
          content: [
            { type: 'text', text: 'pages' },
            { type: 'text', text: '[Image: page 1]' },
            imageBlock('image/png', pngShell(8, 4)),
            { type: 'text', text: '[Image: page 2]' },
            imageBlock('image/png', pngShell(8, 4)),
          ],
        },
      ],
    })
  })

  it('sends at most maxImages, newest first, and says what it held back', () => {
    const history: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look' },
          imageBlock('image/png', pngShell(2, 2)),
          imageBlock('image/png', pngShell(2, 2)),
        ],
      },
      ...step('a'),
      ...step('b'),
    ]
    const live = new Map([
      ['a', liveFor(15)],
      ['b', liveFor(4)],
    ])
    const out = withImageBudget(history, live, true)
    expect(imagesIn(out[4])).toBe(4)
    expect(imagesIn(out[2])).toBe(15)
    expect(imagesIn(out[0])).toBe(1)
    expect(JSON.stringify(out[0])).toContain('Earlier image not resent')

    const tight = withImageBudget(history, live, true, { toolSteps: 2, maxImages: 6 })
    expect(imagesIn(tight[4])).toBe(4)
    expect(imagesIn(tight[2])).toBe(2)
    expect(JSON.stringify(tight[2])).toContain('13 more images not resent')
    expect(hasImages(tight.slice(0, 1))).toBe(false)
  })

  it('sends no image at all without vision', () => {
    const history: MessageParam[] = [
      { role: 'user', content: [imageBlock('image/jpeg', jpegShell(2, 2))] },
      ...step('a'),
    ]
    const out = withImageBudget(history, new Map([['a', liveFor(2)]]), false)
    expect(hasImages(out)).toBe(false)
    expect(out[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: `[Image not sent. ${NO_VISION_NOTE}]` }],
    })
    expect(out[2]).toBe(history[2])
  })
})
