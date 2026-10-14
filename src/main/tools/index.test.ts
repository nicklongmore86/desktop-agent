import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeContext, makeSandbox, type Sandbox } from '../permissions/test-support'
import { toolHarness } from './test-support'

let sb: Sandbox

beforeEach(async () => {
  sb = await makeSandbox()
})

afterEach(async () => {
  await sb.cleanup()
})

describe('createTools', () => {
  it('provides the seven tools with closed object schemas', () => {
    const { tools } = toolHarness(sb)
    expect(Object.keys(tools)).toEqual([
      'list_dir',
      'read_file',
      'search_files',
      'write_file',
      'move_file',
      'delete_path',
      'run_shell',
    ])
    for (const tool of Object.values(tools)) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      for (const key of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties, `${tool.name}.${key}`).toHaveProperty(key)
      }
    }
  })

  it('never throws, whatever the input, and audits every call', async () => {
    const h = toolHarness(sb)
    const junk: unknown[] = [
      undefined,
      null,
      42,
      'str',
      [],
      {},
      { path: 7 },
      { path: '' },
      { command: {} },
    ]
    let calls = 0
    for (const tool of Object.values(h.tools)) {
      for (const input of junk) {
        const result = await tool.execute(input, fakeContext(true).ctx)
        calls++
        expect(result.isError, `${tool.name} ${JSON.stringify(input)}`).toBe(true)
        expect(result.content.length).toBeGreaterThan(0)
      }
    }
    expect(h.audit.entries).toHaveLength(calls)
    expect(h.audit.entries.every((e) => e.outcome === 'error')).toBe(true)
  })

  it('only the mutating tools ask for approval', async () => {
    const h = toolHarness(sb)
    const approvalTools = ['write_file', 'move_file', 'delete_path', 'run_shell']
    for (const tool of Object.values(h.tools)) {
      const entry = await tool.execute({}, fakeContext(true).ctx).then(() => h.audit.entries.at(-1))
      expect(entry?.approval, tool.name).toBe(
        approvalTools.includes(tool.name) ? 'not-requested' : 'auto',
      )
    }
  })

  it('still returns the result when the audit sink throws or rejects', async () => {
    const failures: unknown[] = []
    for (const record of [
      () => {
        throw new Error('disk full')
      },
      () => Promise.reject(new Error('disk full')),
    ]) {
      const h = toolHarness(sb, {
        audit: { record },
        onAuditFailure: (error) => failures.push(error),
      })
      await expect(
        h.tool('list_dir').execute({ path: sb.root }, fakeContext().ctx),
      ).resolves.toMatchObject({ content: expect.stringContaining('(empty)') as unknown })
    }
    expect(failures).toHaveLength(2)
  })
})
