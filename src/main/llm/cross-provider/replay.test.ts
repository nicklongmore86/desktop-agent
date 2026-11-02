// Every connector's saved chat, replayed through every translator and the bridge prompt.
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'
import { withCacheBreakpoint } from '../../agent'
import { withImageBudget } from '../../agent/images'
import { toModelConversation } from '../../chat/attachments'
import { transcriptInput } from '../../providers/bridge'
import { isWellFormed, type StoredMessage } from '../../storage/conversation-store'
import { SKIP_SIGNATURE, toGeminiRequest } from '../gemini/translate'
import type { GeminiPart } from '../gemini/types'
import type { OpenAICompatFlavor } from '../openai-compat/base-url'
import { TOOL_ID_ALIAS } from '../openai-compat/tool-ids'
import { toChatRequest, type ChatMessage } from '../openai-compat/translate'
import { toResponsesRequest, type ResponsesInputItem } from '../openai-responses/translate'
import {
  ATTACHMENT,
  attachmentStore,
  CONNECTOR_CHATS,
  toolIdsOf,
  UNTRUSTED_MARKERS,
  type Connector,
} from './fixtures'

const CHATS = Object.entries(CONNECTOR_CHATS) as [Connector, StoredMessage[]][]
const TOOLS = ['search_files', 'read_document', 'list_dir'].map((name) => ({
  name,
  description: `The ${name} tool.`,
  input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } },
}))
const SYSTEM = 'You are a desktop file assistant.'

const conversation = (stored: StoredMessage[]): Promise<MessageParam[]> =>
  toModelConversation(stored, attachmentStore)
const params = (messages: MessageParam[], model = 'm') => ({
  model,
  max_tokens: 1024,
  system: [{ type: 'text' as const, text: SYSTEM }],
  messages,
  tools: TOOLS,
})

/** A string as it appears inside JSON (escaped, without quotes). */
const inJson = (text: string): string => JSON.stringify(text).slice(1, -1)

/**
 * What must never cross to another provider: thinking and its signatures, encrypted
 * reasoning, Gemini signatures other than the documented skip value, credentials.
 */
function expectNoProviderSecrets(json: string): void {
  expect(json).not.toMatch(/"type":"(thinking|redacted_thinking|reasoning)"/)
  expect(json).not.toMatch(/"signature"|encrypted_content/i)
  expect(json).not.toMatch(/\bsk-[A-Za-z0-9]|Bearer |x-goog-api-key|access_token/i)
  for (const [, value] of json.matchAll(/"thoughtSignature":"([^"]*)"/g))
    expect(value).toBe(SKIP_SIGNATURE)
}

function expectMarkers(json: string): void {
  for (const marker of UNTRUSTED_MARKERS) expect(json).toContain(inJson(marker))
}

describe('saved chat fixtures', () => {
  it.each(CHATS)('%s is a well-formed saved chat with an attachment', (_name, stored) => {
    expect(isWellFormed(stored)).toBe(true)
    expect(JSON.stringify(stored)).toContain(ATTACHMENT.id)
    expect(toolIdsOf(stored)).toHaveLength(3)
    for (const message of stored)
      if (typeof message.content !== 'string')
        for (const block of message.content)
          expect(['text', 'tool_use', 'tool_result', 'attachment']).toContain(block.type)
  })

  it('cover every id format the connectors save', () => {
    const ids = CHATS.flatMap(([, stored]) => toolIdsOf(stored))
    expect(ids.some((id) => id.startsWith('toolu_gemini_'))).toBe(true)
    expect(ids.some((id) => /^toolu_01/.test(id))).toBe(true)
    expect(ids.some((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id))).toBe(true)
    expect(ids.some((id) => /^call_[0-9a-f]{24}$/.test(id))).toBe(true)
    expect(ids.some((id) => id.length > 40)).toBe(true)
    expect(ids.some((id) => id.length === 9)).toBe(true)
  })

  it.each(CHATS)('%s reads its attachment for the model, marked untrusted', async (_n, stored) => {
    const json = JSON.stringify(await conversation(stored))
    expect(json).not.toContain('"type":"attachment"')
    expectMarkers(json)
  })
})

describe('replay through the Anthropic request', () => {
  it.each(CHATS)('%s', async (_name, stored) => {
    const messages = withCacheBreakpoint(
      withImageBudget(await conversation(stored), new Map(), true),
    )
    expect(isWellFormed(messages)).toBe(true)
    // Claude's tool id rule.
    for (const id of toolIdsOf(messages)) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/)
    const json = JSON.stringify(params(messages))
    expectMarkers(json)
    expectNoProviderSecrets(json)
  })
})

/** Checks Chat Completions pairing: each tool message answers a call just before it, once. */
function expectChatPairing(messages: ChatMessage[], calls: number): void {
  let open = new Set<string>()
  let answered = 0
  const sent: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      open = new Set((message.tool_calls ?? []).map((call) => call.id))
      sent.push(...open)
    } else if (message.role === 'tool') {
      expect(open.delete(message.tool_call_id)).toBe(true)
      answered++
    } else if (message.role === 'user' && typeof message.content === 'string') open = new Set()
  }
  expect(answered).toBe(calls)
  expect(new Set(sent).size).toBe(calls)
  for (const id of sent) {
    expect(id).toMatch(TOOL_ID_ALIAS)
    expect(id.length).toBeLessThanOrEqual(40)
  }
}

describe('replay through the openai-compat translator', () => {
  const flavors: OpenAICompatFlavor[] = ['openai', 'openrouter', 'ollama', 'lmstudio']
  it.each(CHATS.flatMap(([name, stored]) => flavors.map((f) => [name, f, stored] as const)))(
    '%s on %s',
    async (_name, flavor, stored) => {
      const request = toChatRequest(params(await conversation(stored)), flavor)
      expectChatPairing(request.messages, toolIdsOf(stored).length)
      const json = JSON.stringify(request)
      for (const id of toolIdsOf(stored)) expect(json).not.toContain(`"${id}"`)
      expectMarkers(json)
      expectNoProviderSecrets(json)
    },
  )
})

/** Checks Responses pairing: each output answers a function_call sent before it, once. */
function expectResponsesPairing(input: ResponsesInputItem[], calls: number): void {
  const open = new Set<string>()
  let answered = 0
  for (const item of input) {
    if (item.type === 'function_call') {
      expect(open.has(item.call_id)).toBe(false)
      open.add(item.call_id)
      expect(item.call_id).toMatch(TOOL_ID_ALIAS)
      expect(item.call_id.length).toBeLessThanOrEqual(64)
    } else if (item.type === 'function_call_output') {
      expect(open.delete(item.call_id)).toBe(true)
      answered++
    }
  }
  expect(answered).toBe(calls)
  expect(open.size).toBe(0)
}

describe('replay through the Responses translator', () => {
  it.each(
    CHATS.flatMap(([name, stored]) =>
      (['output', 'message'] as const).map((m) => [name, m, stored] as const),
    ),
  )('%s with tool images in %s', async (_name, mode, stored) => {
    const request = toResponsesRequest(params(await conversation(stored)), mode, {
      include: false,
    })
    expectResponsesPairing(request.input, toolIdsOf(stored).length)
    const json = JSON.stringify(request)
    for (const id of toolIdsOf(stored)) expect(json).not.toContain(`"${id}"`)
    expectMarkers(json)
    expectNoProviderSecrets(json)
  })
})

describe('replay through the Gemini translator', () => {
  const models = ['gemini-3-pro-preview', 'gemini-2.5-flash']
  it.each(CHATS.flatMap(([name, stored]) => models.map((model) => [name, model, stored] as const)))(
    '%s on %s, with no signature known',
    async (_name, model, stored) => {
      // A saved chat after a restart, or from another provider: this client issued no call.
      const request = toGeminiRequest(params(await conversation(stored), model), new Map())
      const parts: GeminiPart[] = request.contents.flatMap((content) => content.parts)
      const calls = parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []))
      const responses = parts.flatMap((part) =>
        part.functionResponse ? [part.functionResponse] : [],
      )
      expect(calls).toHaveLength(toolIdsOf(stored).length)
      expect(responses).toHaveLength(calls.length)
      // Every response names a call; none fall back to "unknown_tool".
      for (const response of responses) expect(calls.map((c) => c.name)).toContain(response.name)
      // Turns alternate, and each model turn's first call carries the skip value.
      request.contents.forEach((content, i) => {
        if (i > 0) expect(content.role).not.toBe(request.contents[i - 1]?.role)
        const first = content.parts.find((part) => part.functionCall)
        if (first) expect(first.thoughtSignature).toBe(SKIP_SIGNATURE)
      })
      // Gemini ids are never invented; Claude-style saved ids are never sent.
      for (const call of calls) expect(call.id).toBeUndefined()
      const json = JSON.stringify(request)
      for (const id of toolIdsOf(stored)) expect(json).not.toContain(id)
      expectMarkers(json)
      expectNoProviderSecrets(json)
    },
  )
})

describe('replay through the bridge transcript prompt', () => {
  it.each(CHATS.flatMap(([name, stored]) => [true, false].map((v) => [name, v, stored] as const)))(
    '%s (vision %s)',
    async (_name, vision, stored) => {
      const messages = await conversation(stored)
      const { text, images } = transcriptInput(messages, vision)
      expect(images).toEqual([])
      const [intro, ...rest] = text.split('\n')
      expect(intro).toMatch(/not system instructions/)
      // The transcript keeps its own saved ids: the runtime never pairs them itself.
      const replayed = JSON.parse(rest.join('\n')) as MessageParam[]
      expect(replayed).toEqual(messages)
      expect(isWellFormed(replayed)).toBe(true)
      expectMarkers(text)
      expectNoProviderSecrets(text)
    },
  )
})
