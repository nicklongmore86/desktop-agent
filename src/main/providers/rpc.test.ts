import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { RpcPeer } from './rpc'
import { runtimeEnv } from './runtime'

vi.mock('./runtime', async (original) => ({
  ...(await original<typeof import('./runtime')>()),
  killRuntime: vi.fn(),
}))
function fixture(timeout = 1000) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  })
  const peer = new RpcPeer(child as unknown as ChildProcessWithoutNullStreams, timeout)
  return { child, peer }
}

describe('provider transport', () => {
  it('reassembles fragmented UTF-8 JSON and coalesced notifications', async () => {
    const { child, peer } = fixture()
    const events: string[] = []
    peer.onNotification = (_method, params) => events.push(String(params['text']))
    const result = peer.request('initialize')
    const wire = Buffer.from(
      '{"id":1,"result":{"ok":true}}\n{"method":"delta","params":{"text":"hé"}}\n',
    )
    const split = wire.indexOf(Buffer.from('é')) + 1
    child.stdout.write(wire.subarray(0, split))
    child.stdout.write(wire.subarray(split))
    expect(await result).toEqual({ ok: true })
    expect(events).toEqual(['hé'])
    peer.close()
  })
  it('denies unknown server requests without executing anything', async () => {
    const { child, peer } = fixture()
    const writes: string[] = []
    child.stdin.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
    child.stdout.write('{"id":"server-1","method":"exec","params":{}}\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(JSON.parse(writes[0] ?? '{}')).toMatchObject({ id: 'server-1', error: { code: -32601 } })
    peer.close()
  })
  it.each(['malformed\n', '{"id":900,"result":{}}\n', 'x'.repeat(4 * 1024 * 1024 + 1)])(
    'fails closed for invalid framing %#',
    async (wire) => {
      const { child, peer } = fixture()
      const result = peer.request('account/read')
      child.stdout.write(wire)
      await expect(result).rejects.toThrow(/protocol|limit/)
    },
  )
  it('settles pending requests on cancellation and ignores late output', async () => {
    const { child, peer } = fixture()
    const result = peer.request('account/read')
    peer.close()
    child.stdout.write('{"id":1,"result":{}}\n')
    await expect(result).rejects.toThrow('closed')
  })
  it('bounds an unresponsive runtime', async () => {
    const { peer } = fixture(10)
    await expect(peer.request('initialize')).rejects.toThrow('timed out')
  })
  it('does not inherit credentials, endpoint overrides, or injected code', () => {
    expect(
      runtimeEnv({
        PATH: '/bin',
        HOME: '/home/test',
        ANTHROPIC_API_KEY: 'secret',
        OPENAI_API_KEY: 'secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'secret',
        CODEX_HOME: '/evil',
        NODE_OPTIONS: '--require evil',
        HTTPS_PROXY: 'evil',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/home/test' })
  })
})
