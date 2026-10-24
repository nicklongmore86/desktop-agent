import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexRunner, connectCodex, codexLogin } from './codex'
import { launch } from './runtime'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentEvent, AgentTool, ToolResult } from '../agent'
import { imageBlock, NO_VISION_NOTE } from '../agent/images'
import { jpegShell, pngShell } from '../documents/fixtures.test-util'

vi.mock('./runtime', () => ({ launch: vi.fn(), killRuntime: vi.fn(() => Promise.resolve()) }))
const context = {
  file: 'C:\\Program Files\\Codex\\codex.exe',
  cwd: 'C:\\Users\\Test User\\AppData\\providers',
  env: {},
}
let respond: (value: unknown) => void
let frames: Record<string, unknown>[]
let mode:
  | 'normal'
  | 'signed-out'
  | 'inherited'
  | 'bad-isolation'
  | 'usage'
  | 'hang'
  | 'model-error'
  | 'model-timeout'
  | 'retry'
  | 'text-only'
beforeEach(() => {
  frames = []
  vi.mocked(launch).mockClear()
  mode = 'normal'
  vi.mocked(launch).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
    })
    respond = (value) => {
      child.stdout.write(JSON.stringify(value) + '\n')
    }
    child.stdin.on('data', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      frames.push(msg)
      const id = msg['id']
      const result = (value: unknown) => {
        queueMicrotask(() => {
          respond({ id, result: value })
        })
      }
      switch (msg['method']) {
        case 'initialize':
          result({})
          break
        case 'config/read':
          result({
            layers: [
              {
                name: { type: mode === 'inherited' ? 'system' : 'sessionFlags' },
                config: mode === 'inherited' ? { hooks: {} } : {},
              },
            ],
          })
          break
        case 'configRequirements/read':
          result({ requirements: null })
          break
        case 'account/read':
          result({ account: mode === 'signed-out' ? { type: 'apiKey' } : { type: 'chatgpt' } })
          break
        case 'model/list':
          if (mode === 'model-timeout') break
          if (mode === 'model-error') {
            queueMicrotask(() => {
              respond({ id, error: { code: -32000, message: 'Catalog unavailable' } })
            })
            break
          }
          result({
            data: [
              {
                id: 'terra',
                model: 'gpt-5.6-terra',
                displayName: 'Terra',
                isDefault: true,
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
                ...(mode === 'text-only' ? { inputModalities: ['text'] } : {}),
              },
            ],
            nextCursor: null,
          })
          break
        case 'thread/start':
          result({
            model: 'gpt-5.6-terra',
            thread: { id: 'thread', environments: mode === 'bad-isolation' ? [{}] : [] },
            runtimeWorkspaceRoots: [],
            instructionSources: [],
          })
          break
        case 'turn/start':
          if (mode === 'retry')
            queueMicrotask(() => {
              respond({
                method: 'error',
                params: {
                  threadId: 'thread',
                  turnId: 'turn',
                  willRetry: true,
                  error: { codexErrorInfo: 'serverOverloaded' },
                },
              })
            })
          result({ turn: { id: 'turn' } })
          if (mode !== 'hang')
            setImmediate(() => {
              respond({
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread', turnId: 'turn', delta: 'Hello' },
              })
              respond({
                id: 'tool-request',
                method: 'item/tool/call',
                params: {
                  threadId: 'thread',
                  turnId: 'turn',
                  namespace: null,
                  tool: 'read_file',
                  arguments: { path: '/granted/file' },
                },
              })
            })
          break
        case 'account/login/start':
          result({ loginId: 'login', authUrl: 'https://auth.openai.com/authorize?state=test' })
          break
        case 'account/login/cancel':
          result({ status: 'canceled' })
          break
        default:
          if (id === 'tool-request')
            respond({
              method: 'turn/completed',
              params: {
                threadId: 'thread',
                turn: {
                  id: 'turn',
                  status: mode === 'usage' ? 'failed' : 'completed',
                  error: { message: 'usage limit exceeded' },
                },
              },
            })
      }
    })
    return child as unknown as ChildProcessWithoutNullStreams
  })
})
function setup(
  output: ToolResult = { content: 'guarded result' },
  conversation: MessageParam[] = [{ role: 'user', content: 'hello' }],
) {
  const events: AgentEvent[] = []
  const execute = vi.fn(() => Promise.resolve(output))
  const tool: AgentTool = {
    name: 'read_file',
    description: 'Guarded read',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    execute,
  }
  const controller = new AbortController()
  const runner = createCodexRunner(context, [tool])
  const run = () =>
    runner.run(conversation, {
      signal: controller.signal,
      requestApproval: vi.fn(),
      onEvent: (event) => {
        events.push(event)
      },
    })
  return { events, tool, execute, controller, run }
}
describe('Codex app-server adapter', () => {
  it('uses only managed ChatGPT auth and bridges dynamic tools with streaming', async () => {
    const { run, events, execute } = setup()
    const result = await run()
    expect(result.stopReason).toBe('end_turn')
    expect(execute).toHaveBeenCalledOnce()
    expect(events).toContainEqual({ type: 'text_delta', turn: 1, text: 'Hello' })
    expect(frames.find((f) => f['method'] === 'thread/start')?.['params']).toMatchObject({
      environments: [],
      ephemeral: true,
      model: 'gpt-5.6-terra',
      config: { model_reasoning_effort: 'medium' },
      dynamicTools: [{ type: 'function', name: 'read_file' }],
    })
    expect(frames.find((f) => f['id'] === 'tool-request')?.['result']).toEqual({
      contentItems: [{ type: 'inputText', text: 'guarded result' }],
      success: true,
    })
    expect(launch).toHaveBeenCalledWith(
      context.file,
      expect.arrayContaining(['--strict-config', 'forced_login_method="chatgpt"']),
      context.cwd,
      {},
    )
  })
  it.each(['signed-out', 'inherited', 'bad-isolation'] as const)(
    'fails closed for %s',
    async (state) => {
      mode = state
      const { run, execute } = setup()
      expect((await run()).stopReason).toBe(
        state === 'signed-out' ? 'authentication' : 'runtime_unavailable',
      )
      expect(execute).not.toHaveBeenCalled()
      expect(frames.some((f) => f['method'] === 'turn/start')).toBe(false)
    },
  )
  it('reports subscription allowance exhaustion', async () => {
    mode = 'usage'
    const { run, events } = setup()
    expect((await run()).stopReason).toBe('usage_limit')
    expect(frames.filter((frame) => frame['method'] === 'turn/start')).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Codex limit') as unknown,
      }),
    )
  })
  it('cancels a hanging turn and ignores late deltas', async () => {
    mode = 'hang'
    const { run, controller, events } = setup()
    const done = run()
    await vi.waitFor(() => {
      expect(frames.some((f) => f['method'] === 'turn/start')).toBe(true)
    })
    controller.abort()
    expect((await done).stopReason).toBe('aborted')
    respond({ method: 'item/agentMessage/delta', params: { threadId: 'thread', delta: 'late' } })
    expect(events.some((e) => e.type === 'text_delta')).toBe(false)
  })
  it('cancels provider-owned browser login by id', async () => {
    const peer = await connectCodex(context)
    const controller = new AbortController()
    const open = vi.fn(() => Promise.resolve())
    const login = codexLogin(peer, open, controller.signal)
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledOnce()
    })
    controller.abort()
    await expect(login).rejects.toThrow()
    expect(frames).toContainEqual(
      expect.objectContaining({ method: 'account/login/cancel', params: { loginId: 'login' } }),
    )
  })
})

it('does not mutate returned history when a cancelled tool settles late', async () => {
  const { run, execute, controller } = setup()
  let release: (result: { content: string }) => void = () => {}
  execute.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const done = run()
  await vi.waitFor(() => {
    expect(execute).toHaveBeenCalledOnce()
  })
  controller.abort()
  const result = await done
  const snapshot = structuredClone(result.conversation)
  release({ content: 'late result' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(result.conversation).toEqual(snapshot)
})

it.each(['model-error', 'model-timeout'] as const)(
  'uses the runtime default and sends once after %s',
  async (state) => {
    mode = state
    const { run } = setup()
    expect((await run()).stopReason).toBe('end_turn')
    const params = frames.find((frame) => frame['method'] === 'thread/start')?.['params']
    expect(params).not.toHaveProperty('model')
    expect(params).not.toHaveProperty('config')
    expect(frames.filter((frame) => frame['method'] === 'turn/start')).toHaveLength(1)
    expect(launch).toHaveBeenCalledOnce()
  },
)
it('ignores retryable error notifications and accepts the successful runtime completion', async () => {
  mode = 'retry'
  const { run, events } = setup()
  expect((await run()).stopReason).toBe('end_turn')
  expect(events.some((event) => event.type === 'error')).toBe(false)
  expect(frames.filter((frame) => frame['method'] === 'turn/start')).toHaveLength(1)
})

describe('Codex images', () => {
  const page = pngShell(6, 6)
  const photo = jpegShell(3, 3)
  const output: ToolResult = {
    content: 'One page.',
    images: [{ mime: 'image/png', data: page, width: 6, height: 6, label: 'page 1' }],
  }
  const conversation: MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: 'Look' }, imageBlock('image/jpeg', photo)] },
  ]
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

  it('sends images to a model whose catalog entry reads them', async () => {
    const { run } = setup(output, conversation)
    const result = await run()
    expect(result.stopReason).toBe('end_turn')
    expect(frames.find((f) => f['id'] === 'tool-request')?.['result']).toEqual({
      contentItems: [
        { type: 'inputText', text: 'One page.' },
        { type: 'inputText', text: '[Image: page 1]' },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${b64(page)}` },
      ],
      success: true,
    })
    const input = (
      frames.find((f) => f['method'] === 'turn/start')?.['params'] as {
        input: { type: string; text?: string; url?: string }[]
      }
    ).input
    expect(input.map((item) => item.type)).toEqual(['text', 'text', 'image'])
    expect(input[0]?.text).not.toContain(b64(photo))
    expect(input[2]?.url).toBe(`data:image/jpeg;base64,${b64(photo)}`)
    expect(JSON.stringify(result.conversation)).not.toContain(b64(page))
  })

  it('sends none to a model whose catalog says text only, and says so', async () => {
    mode = 'text-only'
    const { run } = setup(output, conversation)
    const result = await run()
    expect(result.stopReason).toBe('end_turn')
    const reply = frames.find((f) => f['id'] === 'tool-request')?.['result'] as {
      contentItems: { type: string; text?: string }[]
    }
    expect(reply.contentItems.map((item) => item.type)).toEqual(['inputText'])
    expect(reply.contentItems[0]?.text).toContain(NO_VISION_NOTE)
    const turn = JSON.stringify(frames.find((f) => f['method'] === 'turn/start'))
    expect(turn).not.toContain('"image"')
    expect(turn).not.toContain(b64(photo))
    expect(turn).toContain(NO_VISION_NOTE)
  })
})
