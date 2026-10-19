// What the tree's context menu and drag-to-chat do with an entry. Each call
// resolves the entry again through PathGuard: the renderer only ever names it.
import type { FileActionResult, FileLocation, FileReferenceResult } from '../../shared/ipc-files'
import type { PathGuard } from '../permissions/guard'
import { nodeListFs, type ListFs } from './listing'
import { CONTROL_CHARS, resolveLocation } from './location'
import { isSecretName } from './secret-names'

type Checked =
  | { ok: true; path: string; isFile: boolean; hardLink: boolean; secret: boolean }
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
    const isFile = stats.isFile()
    return {
      ok: true,
      path: where.path,
      isFile,
      hardLink: stats.nlink > 1,
      // The panels' secret rule applies to files, as in the listing (listing.ts).
      secret: isFile && isSecretName(guard.path.basename(where.path)),
    }
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
  if (entry.secret) return { ok: false, reason: SECRET_REFERENCE }
  if (entry.isFile && entry.hardLink)
    return {
      ok: false,
      reason:
        'This file has other hard links, so the agent cannot open it. Copy it into the folder first.',
    }
  // The reference is one quoted line of the message: a name must not end the quote,
  // start a new line or reorder the text around it (prompt injection through a name).
  if (hasUnsafeReferenceChars(entry.path))
    return {
      ok: false,
      reason: 'This path contains a quote mark or control characters and cannot be referenced.',
    }
  return { ok: true, text: `@"${entry.path}"` }
}

export const SECRET_REFERENCE = 'Secret files (like .env) are not added to the chat from here.'
export const SECRET_REVEAL = 'Secret files cannot be opened or revealed.'

/** Bidirectional formatting characters, which can make text read differently from what it is. */
export const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/** A quote mark, control or bidi character: text that cannot be shown or quoted as it is. */
export function hasUnsafeReferenceChars(text: string): boolean {
  return text.includes('"') || CONTROL_CHARS.test(text) || BIDI_CONTROLS.test(text)
}

/**
 * Runs `act` on the entry's real path once it has been checked.
 *
 * Secret files (secret-names.ts): `secrets: 'refuse'` is for anything that hands
 * the file itself to another program, such as Reveal in Explorer (Explorer can
 * preview or open it). Copy path passes `'allow'`: the path is the granted folder
 * plus the name the panel already shows, and copying it opens nothing.
 */
export async function withEntryPath(
  guard: PathGuard,
  location: FileLocation,
  act: (path: string) => void | Promise<void>,
  secrets: 'refuse' | 'allow',
  fs: ListFs = nodeListFs,
): Promise<FileActionResult> {
  const entry = await check(guard, location, fs)
  if (!entry.ok) return entry
  if (entry.secret && secrets === 'refuse') return { ok: false, reason: SECRET_REVEAL }
  try {
    await act(entry.path)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'That did not work.' }
  }
}
