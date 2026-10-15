import { beforeEach, expect, it, vi } from 'vitest'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeSubscriptionRunner } from './claude'
import type { AgentEvent, AgentTool } from '../agent'

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => Promise<unknown>>(),
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: (
    name: string,
    _description: string,
    _shape: unknown,
    handler: (input: unknown) => Promise<unknown>,
  ) => {
    sdk.handlers.set(name, handler)
    return { name }
  },
  createSdkMcpServer: () => ({ type: 'sdk', name: 'desktop', instance: {} }),
}))
let mode: 'normal' | 'api' | 'bare' | 'cloud' | 'builtin' | 'expired' | 'hang'
let sentInput: boolean
const close = vi.fn()
beforeEach(() => {
  mode = 'normal'
  sentInput = false
  sdk.handlers.clear()
  close.mockClear()
  vi.mocked(query).mockImplementation(
    (request) =>
      ({
        close,
        accountInfo: () =>
          Promise.resolve(
            // Shapes reported by the pinned CLI: subscription sign-in, and --bare (no sign-in read).
            mode === 'bare'
              ? { apiProvider: 'firstParty', tokenSource: 'none' }
              : mode === 'api'
                ? {
                    apiProvider: 'firstParty',
                    apiKeySource: 'ANTHROPIC_API_KEY',
                    subscriptionType: 'Claude Max',
                  }
                : mode === 'cloud'
                  ? { apiProvider: 'bedrock', subscriptionType: 'Claude Max' }
                  : { apiProvider: 'firstParty', subscriptionType: 'Claude Max' },
          ),
        async *[Symbol.asyncIterator]() {
          if (typeof request.prompt === 'string') throw new Error('Expected gated input.')
          for await (const _input of request.prompt) {
            sentInput = true
          }
          yield {
            type: 'system',
            subtype: 'init',
            tools: mode === 'builtin' ? ['Bash'] : ['mcp__desktop__read_file'],
            apiKeySource: 'none',
          } as SDKMessage
          if (mode === 'expired') {
            yield { type: 'assistant', error: 'authentication_failed' } as SDKMessage
            return
          }
          if (mode === 'hang') {
            await new Promise<void>((resolve) => {
              request.options?.abortController?.signal.addEventListener(
                'abort',
                () => {
                  resolve()
                },
                {
                  once: true,
                },
              )
            })
            return
          }
          yield {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
          } as SDKMessage
          await sdk.handlers.get('read_file')?.({ path: '/granted/file' })
          yield { type: 'result', subtype: 'success', is_error: false } as SDKMessage
        },
      }) as unknown as ReturnType<typeof query>,
  )
})
function setup() {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const execute = vi.fn(() => Promise.resolve({ content: 'safe' }))
  const tool: AgentTool = {
    name: 'read_file',
    description: 'Guarded read',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute,
  }
  const runner = createClaudeSubscriptionRunner(
    { file: 'C:\\Program Files\\Claude\\claude.exe', cwd: 'C:\\isolated', env: {} },
    [tool],
  )
  const run = () =>
    runner.run([{ role: 'user', content: 'read' }], {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e)
      },
      requestApproval: vi.fn(),
    })
  return { run, execute, events, controller }
}
it('gates input on subscription auth and bridges only app tools', async () => {
  const { run, execute, events } = setup()
  expect((await run()).stopReason).toBe('end_turn')
  expect(sentInput).toBe(true)
  expect(execute).toHaveBeenCalledOnce()
  expect(events).toContainEqual({ type: 'text_delta', turn: 1, text: 'Hello' })
  const options = vi.mocked(query).mock.calls.at(-1)?.[0].options
  expect(options).toMatchObject({
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    plugins: [],
    extraArgs: { 'disable-slash-commands': null },
    env: {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    managedSettings: { disableAllHooks: true },
    allowedTools: ['mcp__desktop__read_file'],
    persistSession: false,
  })
  // --bare makes the CLI skip the subscription sign-in entirely.
  expect(options?.extraArgs).not.toHaveProperty('bare')
  expect(close).toHaveBeenCalledOnce()
})
it.each([
  ['api', 'Claude subscription sign-in required. API credentials are not accepted.'],
  ['cloud', 'Claude subscription sign-in required. Cloud API providers are not accepted.'],
  ['bare', "Claude isn't signed in with a subscription. Sign in again in Settings."],
] as const)('refuses %s authentication before sending any prompt', async (state, message) => {
  mode = state
  const { run, execute, events } = setup()
  expect((await run()).stopReason).toBe('api')
  expect(sentInput).toBe(false)
  expect(execute).not.toHaveBeenCalled()
  expect(events.at(-1)).toEqual({ type: 'error', code: 'api', message })
})
it.each(['builtin', 'expired'] as const)('fails closed on %s', async (state) => {
  mode = state
  const { run, execute, events } = setup()
  expect((await run()).stopReason).toBe('api')
  expect(execute).not.toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ type: 'error' })
})
it('aborts and closes a streaming SDK session', async () => {
  mode = 'hang'
  const { run, controller } = setup()
  const done = run()
  await vi.waitFor(() => {
    expect(sentInput).toBe(true)
  })
  controller.abort()
  expect((await done).stopReason).toBe('aborted')
  expect(close).toHaveBeenCalledOnce()
})
