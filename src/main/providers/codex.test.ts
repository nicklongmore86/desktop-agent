import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexRunner, connectCodex, codexLogin } from './codex'
import { launch } from './runtime'
import type { AgentEvent, AgentTool } from '../agent'

vi.mock('./runtime', () => ({ launch: vi.fn(), killRuntime: vi.fn(() => Promise.resolve()) }))
const context = {
  file: 'C:\\Program Files\\Codex\\codex.exe',
  cwd: 'C:\\Users\\Test User\\AppData\\providers',
  env: {},
}
let respond: (value: unknown) => void
let frames: Record<string, unknown>[]
let mode: 'normal' | 'signed-out' | 'inherited' | 'bad-isolation' | 'usage' | 'hang'
beforeEach(() => {
  frames = []
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
        case 'thread/start':
          result({
            thread: { id: 'thread', environments: mode === 'bad-isolation' ? [{}] : [] },
            runtimeWorkspaceRoots: [],
            instructionSources: [],
          })
          break
        case 'turn/start':
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
function setup() {
  const events: AgentEvent[] = []
  const execute = vi.fn(() => Promise.resolve({ content: 'guarded result' }))
  const tool: AgentTool = {
    name: 'read_file',
    description: 'Guarded read',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    execute,
  }
  const controller = new AbortController()
  const runner = createCodexRunner(context, [tool])
  const run = () =>
    runner.run([{ role: 'user', content: 'hello' }], {
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
      dynamicTools: [{ name: 'read_file' }],
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
      expect((await run()).stopReason).toBe('api')
      expect(execute).not.toHaveBeenCalled()
      expect(frames.some((f) => f['method'] === 'turn/start')).toBe(false)
    },
  )
  it('reports subscription allowance exhaustion', async () => {
    mode = 'usage'
    const { run, events } = setup()
    expect((await run()).stopReason).toBe('api')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('usage limit') as unknown,
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
