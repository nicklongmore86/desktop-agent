import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeContext, makeSandbox, MemoryAudit, type Sandbox } from '../permissions/test-support'
import { defineTool, errorResult, type RunResult, ToolFailure } from './define'
import { toolHarness } from './test-support'

let sb: Sandbox

beforeEach(async () => {
  sb = await makeSandbox()
})

afterEach(async () => {
  await sb.cleanup()
})

describe('createTools', () => {
  it('provides the file tools and live grant discovery with closed object schemas', () => {
    const { tools } = toolHarness(sb)
    expect(Object.keys(tools)).toEqual([
      'list_granted_folders',
      'list_dir',
      'read_file',
      'read_document',
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
    for (const tool of Object.values(h.tools).filter((t) => t.name !== 'list_granted_folders')) {
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

  it('discovers live grants, reflects revocation, and audits discovery without approval', async () => {
    let roots = [sb.root]
    const { PathGuard } = await import('../permissions/guard')
    const guard = new PathGuard({ roots: () => roots, protectedPaths: [sb.userData] })
    const h = toolHarness(sb, { guard })
    const { ctx, requests } = fakeContext()
    expect(
      JSON.parse((await h.tool('list_granted_folders').execute({}, ctx)).content),
    ).toMatchObject({ roots: [sb.root] })
    roots = []
    expect(
      JSON.parse((await h.tool('list_granted_folders').execute({}, ctx)).content),
    ).toMatchObject({ roots: [] })
    expect(requests).toHaveLength(0)
    expect(h.audit.entries).toHaveLength(2)
    expect((await h.tool('list_granted_folders').execute({ path: '/invented' }, ctx)).isError).toBe(
      true,
    )
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

  it('still returns the result when onAuditFailure itself throws', async () => {
    const h = toolHarness(sb, {
      audit: { record: () => Promise.reject(new Error('disk full')) },
      onAuditFailure: () => {
        throw new Error('reporter broke')
      },
    })
    await expect(
      h.tool('list_dir').execute({ path: sb.root }, fakeContext().ctx),
    ).resolves.toMatchObject({ content: expect.stringContaining('(empty)') as unknown })
  })

  it.each([
    ['an unexpected error', new Error('boom'), 'run failed: boom', 'internal'],
    [
      'a Node error',
      Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }),
      'run failed: EACCES: denied',
      'EACCES',
    ],
    ['a ToolFailure', new ToolFailure('Too big.', 'too-large'), 'Too big.', 'too-large'],
    ['a non-Error value', 'oops', 'run failed: oops', 'internal'],
  ])(
    'turns %s thrown by a tool body into an error result',
    async (_label, thrown, content, code) => {
      const audit = new MemoryAudit()
      const tool = defineTool(
        {
          name: 'run',
          description: 'Throws',
          inputSchema: { type: 'object', properties: {} },
          needsApproval: false,
          parse: () => ({}),
          summarize: () => ({}),
          run: () => Promise.reject(thrown as Error),
        },
        { guard: toolHarness(sb).guard, audit, now: () => 0, onAuditFailure: () => {} },
      )
      await expect(tool.execute({}, fakeContext().ctx)).resolves.toEqual({ content, isError: true })
      expect(audit.entries).toEqual([expect.objectContaining({ outcome: 'error', error: code })])
    },
  )

  it('flags a declined call by its code, never by its wording', async () => {
    const run = (body: () => Promise<RunResult>) =>
      defineTool(
        {
          name: 'run',
          description: 'Fails',
          inputSchema: { type: 'object', properties: {} },
          needsApproval: true,
          parse: () => ({}),
          summarize: () => ({}),
          run: body,
        },
        {
          guard: toolHarness(sb).guard,
          audit: new MemoryAudit(),
          now: () => 0,
          onAuditFailure: () => {},
        },
      ).execute({}, fakeContext().ctx)
    await expect(
      run(() => Promise.resolve(errorResult('No thanks.', 'declined'))),
    ).resolves.toEqual({ content: 'No thanks.', isError: true, declined: true })
    await expect(
      run(() => Promise.reject(new ToolFailure('No thanks.', 'declined'))),
    ).resolves.toEqual({ content: 'No thanks.', isError: true, declined: true })
    // A failure that only reads like a refusal (a path, a command's output) is not one.
    await expect(
      run(() => Promise.resolve(errorResult('The user declined to be found.', 'failed'))),
    ).resolves.toEqual({ content: 'The user declined to be found.', isError: true })
    await expect(run(() => Promise.resolve({ content: 'The user declined' }))).resolves.toEqual({
      content: 'The user declined',
    })
  })
})
