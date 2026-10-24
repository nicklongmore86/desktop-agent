import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { imageDimensions } from '../documents/limits'
import { sniff } from '../documents/sniff'
import type { ToolImage, ToolResult } from '../tools/types'

/**
 * Images in requests (see docs/provider-images.md). Inside the app's history an image
 * is an Anthropic `image` block with base64 data; each client translates it into its
 * provider's form. Nothing here is ever saved: saved chats keep text placeholders only.
 */
export const IMAGE_BUDGET = {
  /** Tool images are resent only from this many of the latest tool steps. */
  toolSteps: 2,
  /** At most this many images in one request, newest first. */
  maxImages: 20,
  /** Largest image sent, encoded (the Anthropic API's per-image limit). */
  maxBytes: 5 * 1024 * 1024,
} as const

/** Formats a request may carry. Tool images are PNG or JPEG; attachments may also be WebP or GIF. */
export type ImageMediaType = Base64ImageSource['media_type']
const MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
const KINDS: Readonly<Record<ImageMediaType, 'png' | 'jpeg' | 'webp' | 'gif'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export const NO_VISION_NOTE =
  'This model cannot see images. Switch to a vision-capable model to show them.'

/**
 * True when `bytes` are what `mime` claims, by their magic bytes, within the size cap and
 * with readable header dimensions (and, when given, the dimensions the caller claims).
 */
export function isSendableImage(
  bytes: Uint8Array,
  mime: string,
  claimed?: { width: number; height: number },
): mime is ImageMediaType {
  if (!MEDIA_TYPES.has(mime) || !(bytes instanceof Uint8Array)) return false
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_BUDGET.maxBytes) return false
  const kind = KINDS[mime as ImageMediaType]
  if (sniff(bytes.subarray(0, 4096)).kind !== kind) return false
  const size = imageDimensions(bytes, kind)
  if (!size || size.width < 1 || size.height < 1) return false
  return !claimed || (claimed.width === size.width && claimed.height === size.height)
}

/**
 * A label the model may read: a few plain words ("page 3"). Anything that could be a path,
 * a URL or a token (slashes, colons, long unbroken runs) falls back to "image N".
 */
export function safeLabel(label: string | undefined, index: number): string {
  const fallback = `image ${String(index + 1)}`
  if (typeof label !== 'string') return fallback
  const text = label.replace(/\s+/g, ' ').trim()
  if (!/^[\p{L}\p{N} ,.()#_+-]{1,60}$/u.test(text)) return fallback
  if (/[\p{L}\p{N}_-]{24,}/u.test(text)) return fallback
  return text
}

export function imageBlock(mime: ImageMediaType, bytes: Uint8Array): ImageBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mime, data: Buffer.from(bytes).toString('base64') },
  }
}

/** A tool's images that passed the checks, with their safe labels, and how many did not. */
export interface CheckedToolImages {
  images: { label: string; block: ImageBlockParam }[]
  dropped: number
}

/** A tool's image as the contract describes it, checked at run time (tools are code too). */
function isToolImage(value: unknown): value is ToolImage {
  if (typeof value !== 'object' || value === null) return false
  const image = value as Record<string, unknown>
  return (
    (image['mime'] === 'image/png' || image['mime'] === 'image/jpeg') &&
    image['data'] instanceof Uint8Array &&
    Number.isSafeInteger(image['width']) &&
    Number.isSafeInteger(image['height']) &&
    (image['label'] === undefined || typeof image['label'] === 'string')
  )
}

export function checkToolImages(images: readonly ToolImage[] | undefined): CheckedToolImages {
  const checked: CheckedToolImages = { images: [], dropped: 0 }
  const list: readonly unknown[] = Array.isArray(images) ? images : []
  for (const [index, image] of list.slice(0, IMAGE_BUDGET.maxImages).entries()) {
    if (
      isToolImage(image) &&
      isSendableImage(image.data, image.mime, { width: image.width, height: image.height })
    )
      checked.images.push({
        label: safeLabel(image.label, index),
        block: imageBlock(image.mime, image.data),
      })
    else checked.dropped += 1
  }
  checked.dropped += Math.max(0, list.length - IMAGE_BUDGET.maxImages)
  return checked
}

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`
const labels = (images: CheckedToolImages['images']): string =>
  images.map((image) => image.label).join(', ')

/**
 * The text a tool result is saved with (and what a model reads once its images have aged
 * out of the request): the tool's content, then a note naming its images. No bytes.
 */
export function savedToolText(
  content: string,
  checked: CheckedToolImages,
  vision: boolean,
): string {
  const notes: string[] = []
  const count = checked.images.length
  if (count > 0)
    notes.push(
      vision
        ? `[${plural(count, 'image')} shown with this result (${labels(checked.images)}). Images are not kept in the conversation; call the tool again to see them.]`
        : `[${plural(count, 'image')} omitted (${labels(checked.images)}). ${NO_VISION_NOTE}]`,
    )
  if (checked.dropped > 0)
    notes.push(
      `[${plural(checked.dropped, 'image')} dropped: not a valid PNG or JPEG within 5 MB.]`,
    )
  return notes.length ? [content, ...notes].filter(Boolean).join('\n\n') : content
}

/** What the agent loop keeps for the current run's tool results that had images. */
export interface LiveToolImages {
  /** The tool's own content, without the saved note. */
  content: string
  images: CheckedToolImages['images']
}

/** Reads a tool result's images for one run: the saved text, and the images to resend. */
export function toolResultImages(
  result: ToolResult,
  vision: boolean,
): { text: string; live: LiveToolImages | null } {
  const checked = checkToolImages(result.images)
  const text = savedToolText(result.content, checked, vision)
  return {
    text,
    live:
      vision && checked.images.length > 0
        ? { content: result.content, images: checked.images }
        : null,
  }
}

const isToolStep = (message: MessageParam): boolean =>
  message.role === 'user' &&
  typeof message.content !== 'string' &&
  message.content.some((block) => block.type === 'tool_result')

const text = (value: string): TextBlockParam => ({ type: 'text', text: value })

/** Starts the text block that names the image right after it, inside a tool result. */
export const IMAGE_LABEL_PREFIX = '[Image: '

/**
 * The request's copy of the history with its images budgeted. Newest first: tool results
 * of this run's last `toolSteps` tool steps get their images back (from `live`), and image
 * blocks already in the history (attachments) are kept, until `maxImages` are in. Older or
 * over-budget images become text saying so; without vision every image does. The history
 * passed in is never modified.
 */
export function withImageBudget(
  history: readonly MessageParam[],
  live: ReadonlyMap<string, LiveToolImages>,
  vision: boolean,
  budget: { toolSteps: number; maxImages: number } = IMAGE_BUDGET,
): MessageParam[] {
  let remaining = vision ? budget.maxImages : 0
  let steps = 0
  const out = [...history]
  for (let index = out.length - 1; index >= 0; index--) {
    const message = out[index]
    if (!message || typeof message.content === 'string') continue
    if (isToolStep(message)) steps += 1
    const content = message.content.map((block): ContentBlockParam => {
      if (block.type === 'image') {
        if (remaining > 0) {
          remaining -= 1
          return block
        }
        return text(
          vision
            ? '[Earlier image not resent, to keep the request small. Ask the user to attach it again if it is needed.]'
            : `[Image not sent. ${NO_VISION_NOTE}]`,
        )
      }
      if (block.type !== 'tool_result') return block
      const images = live.get(block.tool_use_id)
      if (!images || !vision || steps > budget.toolSteps || remaining <= 0) return block
      const kept = images.images.slice(0, remaining)
      remaining -= kept.length
      const resent: ToolResultBlockParam = {
        ...block,
        content: [
          ...(images.content ? [text(images.content)] : []),
          ...kept.flatMap(({ label, block: image }) => [
            text(`${IMAGE_LABEL_PREFIX}${label}]`),
            image,
          ]),
          ...(kept.length < images.images.length
            ? [
                text(
                  `[${plural(images.images.length - kept.length, 'more image')} not resent, to keep the request small; call the tool again to see them.]`,
                ),
              ]
            : []),
        ],
      }
      return resent
    })
    if (content.some((block, i) => block !== message.content[i]))
      out[index] = { ...message, content }
  }
  return out
}

/** True when any message of `history` carries an image block (in content or in a tool result). */
export function hasImages(history: readonly MessageParam[]): boolean {
  return history.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some(
        (block) =>
          block.type === 'image' ||
          (block.type === 'tool_result' &&
            Array.isArray(block.content) &&
            block.content.some((part) => part.type === 'image')),
      ),
  )
}
