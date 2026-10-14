import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog, redactSecrets } from './audit'
import { makeSandbox, put, type Sandbox } from './test-support'

describe('AuditLog', () => {
  let sb: Sandbox

  beforeEach(async () => {
    sb = await makeSandbox()
  })

  afterEach(async () => {
    await sb.cleanup()
  })

  it('appends one JSON line per entry, in order, creating the folder', async () => {
    const file = path.join(sb.userData, 'logs', 'audit.jsonl')
    const log = new AuditLog(file)
    const entry = {
      tool: 'read_file',
      args: { path: '/x' },
      paths: ['/x'],
      approval: 'auto' as const,
      outcome: 'ok' as const,
      durationMs: 3,
    }
    await Promise.all([log.record(entry), log.record({ ...entry, tool: 'list_dir' })])
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(first).toMatchObject(entry)
    expect(typeof first['ts']).toBe('string')
    expect(Number.isNaN(Date.parse(String(first['ts'])))).toBe(false)
    expect((JSON.parse(lines[1] ?? '') as { tool: string }).tool).toBe('list_dir')
    expect(log.healthy).toBe(true)
  })

  it('appends to an existing log without rewriting it', async () => {
    const file = path.join(sb.userData, 'audit.jsonl')
    await put(file, '{"old":true}\n')
    await new AuditLog(file).record({
      tool: 't',
      args: {},
      paths: [],
      approval: 'denied',
      outcome: 'error',
      error: 'declined',
      durationMs: 0,
    })
    const text = await fs.readFile(file, 'utf8')
    expect(text.startsWith('{"old":true}\n')).toBe(true)
    expect(text.split('\n')).toHaveLength(3)
  })

  it('reports write failures without throwing', async () => {
    const onError = vi.fn()
    // A file where the log's folder should be.
    await put(path.join(sb.userData, 'blocker'), '')
    const log = new AuditLog(path.join(sb.userData, 'blocker', 'audit.jsonl'), { onError })
    await expect(
      log.record({
        tool: 't',
        args: {},
        paths: [],
        approval: 'auto',
        outcome: 'ok',
        durationMs: 0,
      }),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
    expect(log.healthy).toBe(false)
    expect(log.lastError).toBeInstanceOf(Error)
  })
})

describe('AuditLog error handling', () => {
  let sb2: Sandbox

  beforeEach(async () => {
    sb2 = await makeSandbox()
  })

  afterEach(async () => {
    await sb2.cleanup()
  })

  it('keeps processing entries when its onError handler throws', async () => {
    await put(path.join(sb2.userData, 'blocker'), '')
    const onError = vi.fn(() => {
      throw new Error('handler broke')
    })
    const log = new AuditLog(path.join(sb2.userData, 'blocker', 'audit.jsonl'), { onError })
    const entry = {
      tool: 't',
      args: {},
      paths: [],
      approval: 'auto' as const,
      outcome: 'ok' as const,
      durationMs: 0,
    }
    await expect(log.record(entry)).resolves.toBeUndefined()
    await expect(log.record(entry)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(2)
  })
})

describe('redactSecrets', () => {
  it('masks common token shapes and key=value secrets', () => {
    expect(redactSecrets('curl -H "x-api-key: sk-ant-api03-abcdefghijklmnop"')).not.toContain(
      'abcdefghijklmnop',
    )
    expect(
      redactSecrets('gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123'),
    ).toContain('[REDACTED]')
    expect(redactSecrets('$env:GITHUB_TOKEN = "hunter2"; git push')).toBe(
      '$env:GITHUB_TOKEN = [REDACTED]; git push',
    )
    expect(redactSecrets('mysql --password=hunter2 db')).toBe('mysql --password=[REDACTED] db')
    expect(redactSecrets('Authorization: Bearer abc.def.ghijklmnop')).not.toContain('ghijklmnop')
    expect(redactSecrets('aws AKIAABCDEFGHIJKLMNOP')).toBe('aws [REDACTED]')
  })

  it('leaves ordinary commands alone', () => {
    expect(redactSecrets('Get-ChildItem -Recurse | Select-Object Name')).toBe(
      'Get-ChildItem -Recurse | Select-Object Name',
    )
    expect(redactSecrets('pwd && ls -la')).toBe('pwd && ls -la')
  })
})
