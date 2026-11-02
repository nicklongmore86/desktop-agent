import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, SendResult } from '../../shared/ipc'
import { GEMINI_FREE_TIER_NOTICE } from '../llm/gemini'
import type { MessageOrigin, StoredMessage } from '../storage/conversation-store'
import { openHistory, type ConversationHistory } from '../storage/history-store'
import { ChatSession, type AgentRunner } from './session'
import { sharingNeed, withSharing, type SharingConnection } from './sharing'
import { memoryLibrary } from './test-support'

/** The registry as the sharing check sees it (services.ts describeConnection). */
const CONNECTIONS: Record<string, SharingConnection> = {
  ollama: { vendor: 'local', label: 'Ollama · Local' },
  lmstudio: { vendor: 'local', label: 'LM Studio · Local' },
  'anthropic-api': { vendor: 'anthropic', label: 'Anthropic · API' },
  'claude-subscription': { vendor: 'anthropic', label: 'Claude · Subscription' },
  'openai-api': { vendor: 'openai', label: 'OpenAI · API' },
  'chatgpt-plan': { vendor: 'openai', label: 'ChatGPT · Plan' },
  'gemini-api': {
    vendor: 'google',
    label: 'Gemini · API',
    geminiKey: true,
    notice: { title: GEMINI_FREE_TIER_NOTICE.title, text: GEMINI_FREE_TIER_NOTICE.text },
  },
}
const describeConnection = (id: string) => CONNECTIONS[id]

/** A prompt answered with a file read: a tool call, its output, and a reply. */
const chat: StoredMessage[] = [
  { role: 'user', content: 'Summarise notes.txt' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'PRIVATE NOTES' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'They are private.' }] },
]
const by = (connection: string, fromIndex = 1): MessageOrigin[] => [
  { fromIndex, connection, model: null },
]

const need = (target: string, origin: MessageOrigin[], home = 'anthropic-api', sharing = []) =>
  sharingNeed({ conversation: chat, origin, home, target, sharing, describe: describeConnection })

describe('sharingNeed: when a chat needs confirmation before it goes elsewhere', () => {
  it('asks for local → cloud, naming the source, destination and what goes', () => {
    expect(need('openai-api', by('ollama'), 'ollama')).toEqual({
      connection: 'openai-api',
      destination: 'OpenAI · API',
      reasons: ['local-to-cloud'],
      sources: ['Ollama · Local'],
      includes: { messages: 4, toolOutput: true, attachments: 0 },
    })
    expect(need('anthropic-api', by('lmstudio'))?.reasons).toEqual(['local-to-cloud'])
    expect(need('chatgpt-plan', by('ollama'))?.destination).toBe('ChatGPT · Plan')
  })

  it('asks when any earlier part is local, even with cloud replies after it', () => {
    const mixed: MessageOrigin[] = [
      { fromIndex: 1, connection: 'ollama', model: 'llama3' },
      { fromIndex: 3, connection: 'anthropic-api', model: 'claude' },
    ]
    expect(need('openai-api', mixed)?.sources).toEqual(['Ollama · Local'])
    // Back to the cloud connection that already answered: the local part still goes there.
    expect(need('anthropic-api', mixed)?.reasons).toEqual(['local-to-cloud'])
  })

  it('treats messages without provenance as the home connection’s', () => {
    expect(need('openai-api', [], 'ollama')?.reasons).toEqual(['local-to-cloud'])
    expect(need('openai-api', [], 'anthropic-api')).toBeNull()
  })

  it('never asks for cloud → cloud, the same vendor, or a local target', () => {
    expect(need('openai-api', by('anthropic-api'))).toBeNull()
    expect(need('anthropic-api', by('chatgpt-plan'))).toBeNull()
    expect(need('claude-subscription', by('anthropic-api'))).toBeNull()
    expect(need('lmstudio', by('ollama'), 'ollama')).toBeNull()
    expect(need('ollama', by('openai-api'))).toBeNull()
    expect(need('ollama', by('ollama'), 'ollama')).toBeNull()
  })

  it('asks before another vendor’s chat goes to a Gemini key, with the free-tier notice', () => {
    const asked = need('gemini-api', by('anthropic-api'))
    expect(asked?.reasons).toEqual(['gemini-free-tier'])
    expect(asked?.notice?.text).toBe(GEMINI_FREE_TIER_NOTICE.text)
    expect(need('gemini-api', by('gemini-api'), 'gemini-api')).toBeNull()
    // Both reasons for local → Gemini.
    expect(need('gemini-api', by('ollama'), 'ollama')?.reasons).toEqual([
      'local-to-cloud',
      'gemini-free-tier',
    ])
  })

  it('treats a connection this build does not know as another vendor, not local', () => {
    expect(need('openai-api', by('future-thing', 0))).toBeNull()
    expect(need('gemini-api', by('future-thing', 0))?.sources).toEqual(['Another connection'])
  })

  it('counts attachments and an empty chat never asks', () => {
    const attached: StoredMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          {
            type: 'attachment',
            id: 'a'.repeat(64),
            name: 'a.txt',
            kind: 'text',
            mime: 'text/plain',
            size: 1,
          },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ]
    const check = { origin: by('ollama'), home: 'ollama', target: 'openai-api', sharing: [] }
    expect(
      sharingNeed({ ...check, conversation: attached, describe: describeConnection })?.includes,
    ).toEqual({ messages: 2, toolOutput: false, attachments: 1 })
    expect(sharingNeed({ ...check, conversation: [], describe: describeConnection })).toBeNull()
  })

  it('a confirmation covers what it was given; local content added later asks again', () => {
    const origin = by('ollama')
    const covered = withSharing([], 'openai-api', chat.length)
    expect(
      sharingNeed({
        conversation: chat,
        origin,
        home: 'ollama',
        target: 'openai-api',
        sharing: covered,
        describe: describeConnection,
      }),
    ).toBeNull()
    // Covers only its own target.
    expect(
      sharingNeed({
        conversation: chat,
        origin,
        home: 'ollama',
        target: 'anthropic-api',
        sharing: covered,
        describe: describeConnection,
      }),
    ).not.toBeNull()
    // Two more local messages after the confirmation.
    const longer = [...chat, { role: 'user' as const, content: 'more' }, chat[3] as StoredMessage]
    expect(
      sharingNeed({
        conversation: longer,
        origin,
        home: 'ollama',
        target: 'openai-api',
        sharing: withSharing([], 'openai-api', chat.length),
        describe: describeConnection,
      }),
    ).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------------------
// The session: main enforces it, whatever the renderer sends.

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const CHAT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

interface World {
  root: string
  histories: Record<string, ConversationHistory>
}

/** Every connection's history on disk, with `messages` saved as a chat of `home`. */
async function world(home: string, messages: StoredMessage[], origin: MessageOrigin[]) {
  const root = await mkdtemp(join(tmpdir(), 'agent-sharing-'))
  directories.push(root)
  const histories: Record<string, ConversationHistory> = {}
  for (const id of Object.keys(CONNECTIONS))
    histories[id] = await openHistory(join(root, id), { newId: () => CHAT_ID })
  await histories[home]?.draft().save(messages, origin)
  return { root, histories }
}

/** A session over `w` with the chat open, replies going to `current` (what restart does). */
async function session(w: World, home: string, current: string) {
  const history = w.histories[home] as ConversationHistory
  const library = memoryLibrary(w.histories, current)
  const events: ChatEvent[] = []
  const runs: MessageParam[][] = []
  const runner: AgentRunner = {
    run: (conversation) => {
      runs.push(conversation)
      return Promise.resolve({
        conversation: [...conversation, { role: 'assistant', content: 'cloud reply' }],
        stopReason: 'end_turn',
      })
    },
  }
  const createRunner = vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      runner,
      origin: { connection: library.current, model: `${library.current}-model` },
    }),
  )
  let n = 0
  const chatSession = new ChatSession({
    history,
    home,
    openId: CHAT_ID,
    library,
    createRunner,
    emit: (event) => events.push(event),
    promptApproval: () => {},
    newId: () => `id-${String(++n)}`,
    describeConnection,
  })
  await chatSession.init()
  return { chat: chatSession, library, events, runs, createRunner }
}

const chatFile = (w: World, home: string) => join(w.root, home, `${CHAT_ID}.json`)
const readChat = async (w: World, home: string) =>
  JSON.parse(await readFile(chatFile(w, home), 'utf8')) as Record<string, unknown>
const refused = (result: SendResult) => {
  if (result.ok || result.code !== 'confirmation_required' || !result.sharing)
    throw new Error(`expected a confirmation refusal, got ${JSON.stringify(result)}`)
  return result.sharing
}

describe('ChatSession: sending a chat to another vendor', () => {
  it('refuses local → cloud in main: no runner is built, nothing is sent or saved', async () => {
    const w = await world('ollama', chat, by('ollama'))
    const before = await readFile(chatFile(w, 'ollama'), 'utf8')
    const { chat: s, createRunner, runs } = await session(w, 'ollama', 'openai-api')
    const result = await s.send('Continue in the cloud')
    const prompt = refused(result)
    expect(prompt).toMatchObject({
      chat: { provider: 'ollama', id: CHAT_ID },
      connection: 'openai-api',
      destination: 'OpenAI · API',
      reasons: ['local-to-cloud'],
      includes: { messages: 4, toolOutput: true, attachments: 0 },
    })
    expect(result.ok ? '' : result.message).toBe(
      'Confirm before this chat is sent to OpenAI · API.',
    )
    expect(createRunner).not.toHaveBeenCalled()
    expect(runs).toEqual([])
    expect(s.state().items).toHaveLength(3)
    expect(await readFile(chatFile(w, 'ollama'), 'utf8')).toBe(before)
  })

  it('cannot be bypassed: resending, a wrong or stale id, or another chat are all refused', async () => {
    const w = await world('ollama', chat, by('ollama'))
    const { chat: s, createRunner, library } = await session(w, 'ollama', 'openai-api')
    const first = refused(await s.send('hi'))
    // Asking again issues a new prompt; the old id no longer confirms anything.
    const second = refused(await s.send('hi'))
    expect(second.id).not.toBe(first.id)
    expect(await s.confirmSharing(first.id)).toMatchObject({ ok: false })
    expect(await s.confirmSharing('id-999')).toMatchObject({ ok: false })
    expect(await s.confirmSharing(undefined)).toMatchObject({ ok: false })
    expect(await s.confirmSharing({ id: second.id })).toMatchObject({ ok: false })
    refused(await s.send('hi'))
    expect(createRunner).not.toHaveBeenCalled()
    // A prompt for one connection cannot confirm another.
    const forOpenAI = refused(await s.send('hi'))
    library.current = 'anthropic-api'
    expect(await s.confirmSharing(forOpenAI.id)).toMatchObject({ ok: false })
    refused(await s.send('hi'))
    expect(createRunner).not.toHaveBeenCalled()
  })

  it('confirmed, the send goes through and the confirmation is saved in the chat file', async () => {
    const w = await world('ollama', chat, by('ollama'))
    const { chat: s, createRunner, runs } = await session(w, 'ollama', 'openai-api')
    const prompt = refused(await s.send('Continue'))
    expect(await s.confirmSharing(prompt.id)).toEqual({ ok: true })
    // The same id cannot be used twice.
    expect(await s.confirmSharing(prompt.id)).toMatchObject({ ok: false })
    expect(await s.send('Continue')).toEqual({ ok: true })
    await s.idle()
    expect(createRunner).toHaveBeenCalledOnce()
    expect(JSON.stringify(runs[0])).toContain('PRIVATE NOTES')
    const saved = await readChat(w, 'ollama')
    // Top level, never on messages: older builds pass messages to the APIs as they are.
    expect(saved['sharing']).toEqual([{ connection: 'openai-api', through: 5 }])
    expect(JSON.stringify(saved['messages'])).not.toContain('sharing')
    expect(saved['version']).toBe(1)
  })

  it('is respected after a restart, and asks again once more local content is added', async () => {
    const w = await world('ollama', chat, by('ollama'))
    const first = await session(w, 'ollama', 'openai-api')
    await first.chat.confirmSharing(refused(await first.chat.send('Continue')).id)
    expect(await first.chat.send('Continue')).toEqual({ ok: true })
    await first.chat.idle()

    // Restart: new histories from disk, a new session.
    const reopened: World = { root: w.root, histories: {} }
    for (const id of Object.keys(CONNECTIONS))
      reopened.histories[id] = await openHistory(join(w.root, id))
    const after = await session(reopened, 'ollama', 'openai-api')
    expect(await after.chat.send('And again')).toEqual({ ok: true })
    await after.chat.idle()
    expect(after.createRunner).toHaveBeenCalledOnce()

    // Back on Ollama: its new replies are not covered, so OpenAI asks again.
    after.library.current = 'ollama'
    expect(await after.chat.send('Local only')).toEqual({ ok: true })
    await after.chat.idle()
    after.library.current = 'openai-api'
    refused(await after.chat.send('Cloud again'))
  })

  it('cancel leaves the chat unchanged and switching back to the local connection works', async () => {
    const w = await world('ollama', chat, by('ollama'))
    const before = await readFile(chatFile(w, 'ollama'), 'utf8')
    const { chat: s, library, createRunner } = await session(w, 'ollama', 'openai-api')
    refused(await s.send('Continue'))
    // Cancel: the renderer just does not confirm. Nothing changed in main or on disk.
    expect(s.state().items).toHaveLength(3)
    expect(await readFile(chatFile(w, 'ollama'), 'utf8')).toBe(before)
    await s.switchConnection('ollama', () => {
      library.current = 'ollama'
      return Promise.resolve()
    })
    expect(await s.send('Continue locally')).toEqual({ ok: true })
    await s.idle()
    expect(createRunner).toHaveBeenCalledOnce()
  })

  it('a confirmation is dropped when the chat changes: switching chats or connection', async () => {
    const w = await world('ollama', chat, by('ollama'))
    const { chat: s, library } = await session(w, 'ollama', 'openai-api')
    const prompt = refused(await s.send('Continue'))
    await s.switchConnection('anthropic-api', () => {
      library.current = 'anthropic-api'
      return Promise.resolve()
    })
    expect(await s.confirmSharing(prompt.id)).toMatchObject({ ok: false })
    refused(await s.send('Continue'))
  })

  it('cloud → cloud sends without asking, as before', async () => {
    const w = await world('anthropic-api', chat, by('anthropic-api'))
    const { chat: s, createRunner } = await session(w, 'anthropic-api', 'openai-api')
    expect(await s.send('Continue')).toEqual({ ok: true })
    await s.idle()
    expect(createRunner).toHaveBeenCalledOnce()
    expect((await readChat(w, 'anthropic-api'))['sharing']).toBeUndefined()
  })

  it('asks before another vendor’s chat goes to a Gemini key', async () => {
    const w = await world('anthropic-api', chat, by('anthropic-api'))
    const { chat: s, createRunner } = await session(w, 'anthropic-api', 'gemini-api')
    const prompt = refused(await s.send('Continue'))
    expect(prompt.reasons).toEqual(['gemini-free-tier'])
    expect(prompt.notice?.title).toBe(GEMINI_FREE_TIER_NOTICE.title)
    expect(createRunner).not.toHaveBeenCalled()
    await s.confirmSharing(prompt.id)
    expect(await s.send('Continue')).toEqual({ ok: true })
    await s.idle()
  })

  it('refuses a runner built for another connection than the one checked', async () => {
    const w = await world('ollama', chat, by('ollama'))
    const { chat: s, library, createRunner } = await session(w, 'ollama', 'ollama')
    // The current connection changes under the send, after the check.
    createRunner.mockImplementationOnce(() => {
      library.current = 'openai-api'
      return Promise.resolve({
        ok: true as const,
        runner: { run: () => Promise.reject(new Error('must not run')) },
        origin: { connection: 'openai-api', model: 'gpt' },
      })
    })
    expect(await s.send('Continue')).toMatchObject({ ok: false, code: 'aborted' })
    expect(s.state().items).toHaveLength(3)
  })
})

describe('ChatSession: context_too_long', () => {
  it('names the model and never shows the provider text', async () => {
    const w = await world('anthropic-api', chat, by('anthropic-api'))
    const { chat: s, events, createRunner } = await session(w, 'anthropic-api', 'openai-api')
    createRunner.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true as const,
        runner: {
          run: (conversation, options) => {
            options.onEvent({
              type: 'error',
              code: 'context_too_long',
              message: 'provider said: 999999 tokens sk-secret',
            })
            return Promise.resolve({ conversation, stopReason: 'context_too_long' })
          },
        },
        origin: { connection: 'openai-api', model: 'gpt-5.5' },
      }),
    )
    expect(await s.send('Continue')).toEqual({ ok: true })
    await s.idle()
    const error = events.find((event) => event.type === 'error')
    expect(error).toMatchObject({
      code: 'context_too_long',
      message:
        'This chat is too long for gpt-5.5. Start a new chat, fork from a later prompt, or switch to a model with a larger context.',
    })
    // Nothing was cut: the whole history stays, with the new prompt.
    expect(s.state().items).toHaveLength(4)
  })
})
