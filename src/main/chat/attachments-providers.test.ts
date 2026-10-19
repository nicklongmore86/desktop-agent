// Every provider path gets a valid request for a prompt with attachments: the
// session hands each one the same text form (see toModelConversation).
import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../shared/attachments'
import { createAgent, type AgentClient } from '../agent'
import { createGeminiClient } from '../llm/gemini'
import { createOpenAICompatClient } from '../llm/openai-compat'
import { createChatGPTResponsesClient } from '../llm/openai-responses'
import { transcriptPrompt } from '../providers/bridge'
import { attachmentPlaceholder, inlineText, type AttachmentStoreLike } from './attachments'
import { ChatSession, type AgentRunner } from './session'
import { memoryHistory } from './test-support'

const notes: AttachmentRef = {
  id: 'a'.repeat(64),
  name: 'notes.md',
  kind: 'text',
  mime: 'text/markdown',
  size: 11,
}
const photo: AttachmentRef = {
  id: 'b'.repeat(64),
  name: 'photo.png',
  kind: 'image',
  mime: 'image/png',
  size: 2048,
}
const store: AttachmentStoreLike = {
  has: (id) => Promise.resolve(id === notes.id || id === photo.id),
  read: (id) => Promise.resolve(id === notes.id ? new TextEncoder().encode('Ship Friday') : null),
}
const NOTES = inlineText(notes, 'Ship Friday')
const PHOTO = attachmentPlaceholder(photo)

/** Records each request body; answers 400 so the run ends after the first request. */
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

/** No request ever carries an attachment block, or the stored file's id. */
function expectClean(body: unknown): void {
  const text = JSON.stringify(body)
  expect(text).not.toContain('"attachment"')
  expect(text).not.toContain(notes.id)
}

/** Sends a prompt with both attachments through a session whose runner is `runner`. */
async function send(runner: AgentRunner): Promise<void> {
  const session = new ChatSession({
    history: memoryHistory(),
    createRunner: () => Promise.resolve({ ok: true, runner }),
    emit: () => {},
    promptApproval: () => {},
    attachments: store,
  })
  await session.init()
  expect(await session.send('Summarise these', [notes, photo])).toEqual({ ok: true })
  await session.idle()
}

const agentOf = (client: AgentClient) => createAgent({ client, tools: [] })

describe('a prompt with attachments reaches every provider as valid text', () => {
  it('Claude API', async () => {
    const { bodies, fetch } = capture()
    const client = new Anthropic({ apiKey: 'sk-ant-test', fetch, maxRetries: 0 })
    await send(agentOf(client))
    const body = bodies[0] as { messages: MessageParam[] }
    expect(bodies).toHaveLength(1)
    expectClean(body)
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarise these' },
          { type: 'text', text: NOTES },
          { type: 'text', text: PHOTO, cache_control: { type: 'ephemeral' } },
        ],
      },
    ])
  })

  it('OpenAI-compatible (Chat Completions)', async () => {
    const { bodies, fetch } = capture()
    const client = createOpenAICompatClient({
      baseUrl: 'http://127.0.0.1:9/v1',
      flavor: 'ollama',
      model: 'llama3',
      fetch,
    })
    await send(agentOf(client))
    const body = bodies[0] as { messages: { role: string; content: string }[] }
    expect(bodies).toHaveLength(1)
    expectClean(body)
    expect(body.messages.filter((m) => m.role === 'user')).toEqual([
      { role: 'user', content: ['Summarise these', NOTES, PHOTO].join('\n\n') },
    ])
  })

  it('ChatGPT plan (Responses)', async () => {
    const { bodies, fetch } = capture()
    const client = createChatGPTResponsesClient({
      model: 'gpt-6.1-sol',
      getAccessToken: () => Promise.resolve('token'),
      fetch,
    })
    await send(agentOf(client))
    const body = bodies[0] as { input: unknown[] }
    expect(bodies).toHaveLength(1)
    expectClean(body)
    const text = JSON.stringify(body.input)
    expect(body.input).toHaveLength(1)
    for (const part of ['Summarise these', NOTES, PHOTO])
      expect(text).toContain(JSON.stringify(part).slice(1, -1))
  })

  it('Gemini', async () => {
    const { bodies, fetch } = capture()
    const client = createGeminiClient({ apiKey: 'AIza-test', model: 'gemini-test', fetch })
    await send(agentOf(client))
    const body = bodies[0] as { contents: unknown[] }
    expect(bodies).toHaveLength(1)
    expectClean(body)
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Summarise these' }, { text: NOTES }, { text: PHOTO }] },
    ])
  })

  it.each(['Claude', 'Codex'])('%s subscription (transcript prompt)', async () => {
    const prompts: string[] = []
    await send({
      run(conversation) {
        prompts.push(transcriptPrompt(conversation))
        return Promise.resolve({ conversation, stopReason: 'end_turn' })
      },
    })
    const data = JSON.parse(prompts[0]?.split('\n').slice(1).join('\n') ?? '') as unknown
    expectClean(data)
    expect(data).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarise these' },
          { type: 'text', text: NOTES },
          { type: 'text', text: PHOTO },
        ],
      },
    ])
  })
})
