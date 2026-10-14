import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeSandbox, type Sandbox } from '../permissions/test-support'
import { toolHarness } from '../tools/test-support'
import { ToolBridge } from './bridge'
let sb: Sandbox
beforeEach(async () => {
  sb = await makeSandbox()
})
afterEach(async () => {
  await sb.cleanup()
})
it('keeps subscription calls behind PathGuard, audit, input validation and approvals', async () => {
  const h = toolHarness(sb)
  const approval = vi.fn(() => Promise.resolve(false))
  const bridge = new ToolBridge([{ role: 'user', content: 'test' }], Object.values(h.tools), {
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    requestApproval: approval,
  })
  expect((await bridge.call('read_file', { path: join(sb.outside, 'secret') })).isError).toBe(true)
  expect(
    (await bridge.call('read_file', { path: join(sb.root, '.codex', 'auth.json') })).isError,
  ).toBe(true)
  expect(
    (await bridge.call('read_file', { path: join(sb.root, '.claude', '.credentials.json') }))
      .isError,
  ).toBe(true)
  expect(
    (await bridge.call('write_file', { path: join(sb.root, 'test.txt'), content: 'hello' }))
      .isError,
  ).toBe(true)
  expect(approval).toHaveBeenCalledTimes(1)
  expect(h.audit.entries).toHaveLength(4)
  expect(h.audit.entries.at(-1)?.approval).toBe('denied')
  await expect(bridge.call('Bash', { command: 'whoami' })).rejects.toThrow('unregistered')
})
it('does not execute calls after cancellation', async () => {
  const h = toolHarness(sb)
  const controller = new AbortController()
  controller.abort()
  const bridge = new ToolBridge([], Object.values(h.tools), {
    signal: controller.signal,
    onEvent: vi.fn(),
    requestApproval: vi.fn(),
  })
  await expect(bridge.call('read_file', { path: sb.root })).rejects.toThrow()
  expect(h.audit.entries).toHaveLength(0)
})
