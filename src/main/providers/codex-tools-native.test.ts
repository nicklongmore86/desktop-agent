import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTools } from '../tools'
import { PathGuard } from '../permissions/guard'
import { ToolBridge } from './bridge'
import { connectCodex, codexThreadOptions } from './codex'
import { discoverRuntime, runtimeEnv } from './runtime'

// Exercise the pinned native runtime's model-facing tool declarations and dispatch,
// rather than a fake app-server that accepts arbitrary thread/start arguments.
it('native Codex discovers grants and lists a folder through the guarded tool bridge', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'Desktop tool roundtrip ')))
  const cwd = join(root, 'workspace')
  const home = join(root, 'auth')
  const granted = join(root, 'Downloads')
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(join(granted, 'RFI'), { recursive: true })])
  const env = { ...runtimeEnv(), HOME: home, USERPROFILE: home, CODEX_HOME: home }
  const resourcesPath = process.env['DESKTOP_TEST_RESOURCES']
  const file = await discoverRuntime(
    'codex',
    {},
    { home, cwd, env, ...(resourcesPath ? { resourcesPath } : {}) },
  )
  if (!file) throw new Error('Missing pinned Codex runtime')
  const tools = createTools({
    guard: new PathGuard({ roots: () => [granted], protectedPaths: [home] }),
    audit: { record: () => Promise.resolve() },
    trash: () => Promise.reject(new Error('No writes in this test')),
  })
  let approvals = 0
  const bridge = new ToolBridge([], tools, {
    signal: new AbortController().signal,
    onEvent: () => {},
    requestApproval: () => {
      approvals++
      return Promise.resolve(false)
    },
  })
  const requests: string[] = []
  let step = 0
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    requests.push(raw)
    const request = JSON.parse(raw) as { input: unknown[] }
    const codeMode = JSON.stringify(request.input).includes('Run JavaScript code to orchestrate')
    const call = codeMode
      ? {
          type: 'custom_tool_call',
          id: 'item-1',
          call_id: 'call-1',
          name: 'exec',
          namespace: 'functions',
          input: `const r = await tools.list_granted_folders({}); text(r); text(await tools.list_dir({path:${JSON.stringify(granted)}})); text(await tools.run_shell({cwd:${JSON.stringify(granted)},command:'echo should-not-run'})); text(await tools.read_file({path:${JSON.stringify(join(home, 'private.txt'))}}));`,
        }
      : {
          type: 'function_call',
          id: `item-${String(step)}`,
          call_id: `call-${String(step)}`,
          name: ['list_granted_folders', 'list_dir', 'run_shell', 'read_file'][step],
          namespace: 'functions',
          arguments:
            step === 0
              ? '{}'
              : JSON.stringify(
                  step === 1
                    ? { path: granted }
                    : step === 2
                      ? { cwd: granted, command: 'echo should-not-run' }
                      : { path: join(home, 'private.txt') },
                ),
        }
    const finished = step++ >= (codeMode ? 1 : 4)
    const output = finished
      ? [
          {
            type: 'message',
            id: 'message-1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Found RFI.', annotations: [] }],
          },
        ]
      : [call]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`)
    event('response.created', {
      response: { id: `response-${String(step)}`, status: 'in_progress', output: [] },
    })
    for (const item of output) event('response.output_item.done', { output_index: 0, item })
    event('response.completed', {
      response: {
        id: `response-${String(step)}`,
        status: 'completed',
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })
    res.end()
  }
  const server = createServer((req, res) => {
    void serve(req, res).catch(() => {
      res.writeHead(500)
      res.end('Test server failed')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local test port')
  const peer = await connectCodex({ file, cwd, env })
  const calls: string[] = []
  const outputs: string[] = []
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  peer.onRequest = async (method, params) => {
    expect(method).toBe('item/tool/call')
    expect(params['namespace'] ?? null).toBeNull()
    const name = String(params['tool'])
    calls.push(name)
    const { result } = await bridge.call(name, params['arguments'])
    outputs.push(result.content)
    return { contentItems: [{ type: 'inputText', text: result.content }], success: !result.isError }
  }
  peer.onNotification = (method) => {
    if (method === 'turn/completed') finish()
  }
  try {
    const started = await peer.request('thread/start', {
      ...codexThreadOptions({ file, cwd, env }, tools),
      model: 'gpt-5.6-terra',
      config: {
        model_reasoning_effort: 'medium',
        model_provider: 'local_test',
        model_providers: {
          local_test: {
            name: 'Local tool test',
            base_url: `http://127.0.0.1:${String(address.port)}`,
            wire_api: 'responses',
            requires_openai_auth: false,
          },
        },
      },
    })
    expect(started['model']).toBe('gpt-5.6-terra')
    expect(started['reasoningEffort']).toBe('medium')
    await peer.request('turn/start', {
      threadId: (started['thread'] as { id: string }).id,
      input: [{ type: 'text', text: 'Find the RFI folder in my Downloads.', text_elements: [] }],
    })
    await Promise.race([
      done,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Native tool roundtrip timed out'))
        }, 15000)
        timer.unref()
      }),
    ])
    expect(calls).toEqual(['list_granted_folders', 'list_dir', 'run_shell', 'read_file'])
    expect(outputs[3]).toMatch(/access denied/i)
    expect(approvals).toBe(1)
    expect(outputs[2]).toMatch(/declined/i)
    expect(outputs[0]).toContain('Downloads')
    expect(outputs[1]).toContain('RFI/')
    expect(requests.join('\n')).toContain('list_granted_folders')
  } finally {
    peer.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 30000)
