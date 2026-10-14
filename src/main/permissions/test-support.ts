// Helpers for the permissions and tools tests. Not imported by app code.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ApprovalRequest, ToolContext } from '../tools/types'
import type { AuditEntry, AuditSink } from './audit'
import type { GuardFs } from './guard'

/** A temp folder with a granted `root`, an ungranted `outside` and the app's `userData`. */
export interface Sandbox {
  base: string
  root: string
  outside: string
  userData: string
  cleanup(): Promise<void>
}

export async function makeSandbox(): Promise<Sandbox> {
  // realpath: the temp dir may itself sit behind a link (/var on macOS, 8.3 names on Windows).
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-agent-')))
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  const userData = path.join(base, 'userData')
  await Promise.all([fs.mkdir(root), fs.mkdir(outside), fs.mkdir(userData)])
  return {
    base,
    root,
    outside,
    userData,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  }
}

/** Writes a file, creating parent folders. */
export async function put(file: string, content: string | Buffer = ''): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Creates a symlink (a junction for folders on Windows, which needs no
 * privileges). Returns false when the OS refuses (Windows without Developer
 * Mode for file links), so the test can skip.
 */
export async function trySymlink(
  target: string,
  link: string,
  kind: 'file' | 'dir',
): Promise<boolean> {
  try {
    await fs.symlink(target, link, kind === 'dir' ? 'junction' : 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

export class MemoryAudit implements AuditSink {
  readonly entries: Omit<AuditEntry, 'ts'>[] = []

  record(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    this.entries.push(entry)
    return Promise.resolve()
  }
}

type Answer = boolean | ((req: ApprovalRequest) => boolean | Promise<boolean>)

/** A ToolContext whose approvals answer `answer` and are recorded in `requests`. */
export function fakeContext(answer: Answer = true): {
  ctx: ToolContext
  requests: ApprovalRequest[]
  controller: AbortController
} {
  const requests: ApprovalRequest[] = []
  const controller = new AbortController()
  const ctx: ToolContext = {
    signal: controller.signal,
    requestApproval: (req) => {
      requests.push(req)
      return Promise.resolve(typeof answer === 'function' ? answer(req) : answer)
    },
  }
  return { ctx, requests, controller }
}

function enoent(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
}

/**
 * An in-memory Windows file system for the guard. `entries` are real paths
 * that exist (folders and files); `links` map a link's path to its target.
 * Lookups ignore case and return the stored case, like NTFS. A link target
 * starting with `\\` stands for a network share and is not checked further.
 */
export function fakeWindowsFs(
  entries: readonly string[],
  links: Record<string, string> = {},
): GuardFs {
  const real = new Map(entries.map((p) => [p.toLowerCase(), p]))
  const linkMap = new Map(Object.entries(links).map(([k, v]) => [k.toLowerCase(), v]))
  const resolve = (p: string): string => {
    const parts = path.win32
      .normalize(p)
      .split('\\')
      .filter((s) => s !== '')
    let current = (parts.shift() ?? '').toUpperCase()
    let network = false
    for (const part of parts) {
      if (network) {
        current = `${current}\\${part}`
        continue
      }
      const candidate = `${current}\\${part}`
      const key = candidate.toLowerCase()
      const target = linkMap.get(key)
      if (target !== undefined) {
        network = target.startsWith('\\\\')
        current = network ? target : resolve(target)
        continue
      }
      const stored = real.get(key)
      if (stored === undefined) throw enoent(p)
      current = stored
    }
    return parts.length === 0 ? `${current}\\` : current
  }
  return {
    realpath: async (p) => Promise.resolve().then(() => resolve(p)),
    lstat: (p) => {
      const key = path.win32.normalize(p).toLowerCase()
      return real.has(key) || linkMap.has(key) ? Promise.resolve({}) : Promise.reject(enoent(p))
    },
  }
}
