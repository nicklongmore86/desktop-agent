// Image attachments reach vision connections as images, in each provider's own form,
// marked as user-provided data; the saved chat keeps only the attachment reference.
import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../shared/attachments'
import { createAgent, type AgentClient } from '../agent'
import { IMAGE_BUDGET } from '../agent/images'
import { jpegShell, pngShell } from '../documents/fixtures.test-util'
import { createGeminiClient } from '../llm/gemini'
import { createOpenAICompatClient } from '../llm/openai-compat'
import { createChatGPTResponsesClient } from '../llm/openai-responses'
import type { StoredMessage } from '../storage/conversation-store'
import {
  attachmentPlaceholder,
  imageIntro,
  noVisionPlaceholder,
  toModelConversation,
  type AttachmentStoreLike,
} from './attachments'
import { ChatSession, type AgentRunner } from './session'
import { memoryHistory } from './test-support'

const ref = (id: string, name: string, mime: string, size: number): AttachmentRef => ({
  id: id.repeat(64),
  name,
  kind: 'image',
  mime,
  size,
})
const PHOTO_BYTES = pngShell(5, 5)
const photo = ref('b', 'photo.png', 'image/png', PHOTO_BYTES.byteLength)
/** Says PNG, holds a JPEG: never sent as an image. */
const liar = ref('c', 'liar.png', 'image/png', 20)
const files = [photo, liar]
const bytes = new Map<string, Uint8Array>([
  [photo.id, PHOTO_BYTES],
  [liar.id, jpegShell(2, 2)],
])
const store: AttachmentStoreLike = {
  has: (id) => Promise.resolve(bytes.has(id)),
  describe: (id) => Promise.resolve(files.find((file) => file.id === id) ?? null),
  isIssued: (id) => files.some((file) => file.id === id),
  read: (id) => Promise.resolve(bytes.get(id) ?? null),
}
const B64 = Buffer.from(PHOTO_BYTES).toString('base64')
const INTRO = imageIntro(photo)
const LIAR = attachmentPlaceholder(liar)

function capture() {
  const bodies: unknown[] = []
  const fetch = (_input: unknown, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : ''))
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: 'stop here', type: 'invalid_request' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { bodies, fetch }
}

async function send(runner: AgentRunner) {
  const history = memoryHistory()
  const session = new ChatSession({
    history,
    createRunner: () => Promise.resolve({ ok: true, runner }),
    emit: () => {},
    promptApproval: () => {},
    attachments: store,
  })
  await session.init()
  expect(await session.send('What is this?', [photo, liar])).toEqual({ ok: true })
  await session.idle()
  return history
}

const seeing = (client: AgentClient) => createAgent({ client, tools: [], vision: true })

describe('image attachments reach vision connections as images', () => {
  it('Claude API: an image block after its untrusted-data introduction', async () => {
    const { bodies, fetch } = capture()
    const history = await send(
      seeing(new Anthropic({ apiKey: 'sk-ant-test', fetch, maxRetries: 0 })),
    )
    const body = bodies[0] as { messages: MessageParam[] }
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'text', text: INTRO },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
          { type: 'text', text: LIAR, cache_control: { type: 'ephemeral' } },
        ],
      },
    ])
    // The saved chat has the reference only.
    const saved = JSON.stringify(await history.current().load())
    expect(saved).not.toContain(B64)
    expect(saved).toContain('"attachment"')
  })

  it('OpenAI-compatible: image_url parts in the user message', async () => {
    const { bodies, fetch } = capture()
    await send(
      seeing(
        createOpenAICompatClient({
          baseUrl: 'http://127.0.0.1:9/v1',
          flavor: 'ollama',
          model: 'llava',
          fetch,
        }),
      ),
    )
    const body = bodies[0] as { messages: { role: string; content: unknown }[] }
    expect(body.messages.filter((m) => m.role === 'user')).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'text', text: INTRO },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
          { type: 'text', text: LIAR },
        ],
      },
    ])
  })

  it('ChatGPT plan: input_image content', async () => {
    const { bodies, fetch } = capture()
    await send(
      seeing(
        createChatGPTResponsesClient({
          model: 'gpt-6.1-sol',
          getAccessToken: () => Promise.resolve('token'),
          fetch,
        }),
      ),
    )
    expect((bodies[0] as { input: unknown[] }).input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_text', text: INTRO },
          { type: 'input_image', image_url: `data:image/png;base64,${B64}`, detail: 'auto' },
          { type: 'input_text', text: LIAR },
        ],
      },
    ])
  })

  it('Gemini: inlineData parts', async () => {
    const { bodies, fetch } = capture()
    await send(
      seeing(createGeminiClient({ apiKey: 'AIza-test', model: 'gemini-2.5-flash', fetch })),
    )
    expect((bodies[0] as { contents: unknown[] }).contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'What is this?' },
          { text: INTRO },
          { inlineData: { mimeType: 'image/png', data: B64 } },
          { text: LIAR },
        ],
      },
    ])
  })

  it('a connection without vision gets a note and no bytes', async () => {
    const { bodies, fetch } = capture()
    await send(
      createAgent({ client: new Anthropic({ apiKey: 'k', fetch, maxRetries: 0 }), tools: [] }),
    )
    const text = JSON.stringify(bodies[0])
    expect(text).not.toContain(B64)
    expect(text).toContain(JSON.stringify(noVisionPlaceholder(photo)).slice(1, -1))
  })
})

describe('toModelConversation images', () => {
  it('reads only the newest IMAGE_BUDGET.maxImages image attachments', async () => {
    const reads: string[] = []
    const many = Array.from({ length: 25 }, (_, i) =>
      ref(
        i.toString(16).padStart(2, '0'),
        `p${String(i)}.png`,
        'image/png',
        PHOTO_BYTES.byteLength,
      ),
    ).map((r) => ({ ...r, id: r.id.slice(0, 64) }))
    const messages: StoredMessage[] = [
      { role: 'user', content: many.slice(0, 15).map((r) => ({ type: 'attachment', ...r })) },
      { role: 'assistant', content: 'Seen.' },
      { role: 'user', content: many.slice(15).map((r) => ({ type: 'attachment', ...r })) },
    ]
    const counting: AttachmentStoreLike = {
      ...store,
      read: (id) => {
        reads.push(id)
        return Promise.resolve(PHOTO_BYTES)
      },
    }
    const out = await toModelConversation(messages, counting, new Set(), { vision: true })
    expect(reads).toHaveLength(IMAGE_BUDGET.maxImages)
    const count = (m: MessageParam | undefined) =>
      Array.isArray(m?.content) ? m.content.filter((b) => b.type === 'image').length : 0
    expect(count(out[2])).toBe(10)
    expect(count(out[0])).toBe(10)
    expect(JSON.stringify(out[0])).toContain('not resent, to keep the request small')

    reads.length = 0
    const blind = await toModelConversation(messages, counting, new Set(), { vision: false })
    expect(reads).toEqual([])
    expect(JSON.stringify(blind)).toContain('This model cannot see images')
  })

  it('never sends an image the store holds no more, or one over 5 MB', async () => {
    const big = new Uint8Array(IMAGE_BUDGET.maxBytes + 1)
    big.set(PHOTO_BYTES)
    const messages: StoredMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'attachment', ...photo },
          { type: 'attachment', ...liar },
        ],
      },
    ]
    const out = await toModelConversation(
      messages,
      { ...store, read: (id) => Promise.resolve(id === photo.id ? big : null) },
      new Set(),
      { vision: true },
    )
    expect(JSON.stringify(out)).not.toContain('"image"')
    expect(JSON.stringify(out)).toContain('no longer available')
  })
})
