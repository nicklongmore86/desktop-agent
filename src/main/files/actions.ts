// What the tree's context menu and drag-to-chat do with an entry. Each call
// resolves the entry again through PathGuard: the renderer only ever names it.
import type { FileActionResult, FileLocation, FileReferenceResult } from '../../shared/ipc-files'
import type { PathGuard } from '../permissions/guard'
import { nodeListFs, type ListFs } from './listing'
import { resolveLocation } from './location'
import { isSecretName } from './secret-names'

type Checked =
  | { ok: true; path: string; isFile: boolean; hardLink: boolean }
  | {
      ok: false
      reason: string
    }

async function check(guard: PathGuard, location: FileLocation, fs: ListFs): Promise<Checked> {
  const where = await resolveLocation(guard, location)
  if (!where.ok) return where
  if (!where.exists) return { ok: false, reason: 'That file or folder no longer exists.' }
  try {
    const stats = await fs.lstat(where.path)
    if (stats.isSymbolicLink()) return { ok: false, reason: 'Links are not followed.' }
    return { ok: true, path: where.path, isFile: stats.isFile(), hardLink: stats.nlink > 1 }
  } catch {
    return { ok: false, reason: 'That file or folder cannot be read.' }
  }
}

/**
 * The text that refers to an entry in a message: its full path, quoted, after
 * an `@`. It is only text: it gives the agent no access, and every tool the
 * agent uses on it resolves the path through PathGuard again. Refused for the
 * panels' secret files and for files the tools would refuse (hard links).
 */
export async function referenceFor(
  guard: PathGuard,
  location: FileLocation,
  fs: ListFs = nodeListFs,
): Promise<FileReferenceResult> {
  const entry = await check(guard, location, fs)
  if (!entry.ok) return entry
  if (entry.isFile && isSecretName(guard.path.basename(entry.path)))
    return { ok: false, reason: 'Secret files (like .env) are not added to the chat from here.' }
  if (entry.isFile && entry.hardLink)
    return {
      ok: false,
      reason:
        'This file has other hard links, so the agent cannot open it. Copy it into the folder first.',
    }
  if (entry.path.includes('"'))
    return { ok: false, reason: 'This path contains a quote mark and cannot be referenced.' }
  return { ok: true, text: `@"${entry.path}"` }
}

/** Runs `act` on the entry's real path once it has been checked (Reveal, Copy path). */
export async function withEntryPath(
  guard: PathGuard,
  location: FileLocation,
  act: (path: string) => void | Promise<void>,
  fs: ListFs = nodeListFs,
): Promise<FileActionResult> {
  const entry = await check(guard, location, fs)
  if (!entry.ok) return entry
  try {
    await act(entry.path)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'That did not work.' }
  }
}
