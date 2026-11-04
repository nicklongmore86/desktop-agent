// Files and folders a chat reply names, made clickable. Reply text is hostile (the agent reads
// untrusted documents, and file names are attacker-chosen), so the renderer only PROPOSES a
// piece of text. This file decides, in main, against the CURRENT grants and through the same
// guard as the Files panel (location.ts, actions.ts): links, junctions and 8.3 aliases are not
// followed, hard-linked files and secret files are refused, and nothing outside a granted
// folder is looked at (the text is compared with the grants as text before any file is touched).
//
// What a click does:
//   folder                          -> opened in Explorer
//   file of an OPEN_EXTENSIONS type -> opened with its default app
//   any other file                  -> shown in Explorer, never launched
// Nothing here runs code: a launcher, script, shortcut or macro-capable Office file is only ever
// revealed.
import type { MentionAction, MentionOpenResult, MentionResolution } from '../../shared/ipc-files'
import { MENTION_MAX_TEXT } from '../../shared/ipc-files'
import type { AuditSink } from '../permissions/audit'
import type { PathGuard } from '../permissions/guard'
import { isInside } from '../permissions/paths'
import { BIDI_CONTROLS, check, SECRET_REVEAL, type Checked } from './actions'
import { nodeListFs, type ListFs } from './listing'
import { CONTROL_CHARS, rootId } from './location'

/**
 * The file types a click opens with their default app: plain text and logs, documents without
 * macros, spreadsheets and presentations without macros, and still images. Everything else is
 * shown in Explorer instead.
 *
 * Left out on purpose: macro-capable Office files (docm, xlsm, pptm, dotm, xlsb, xls, doc, ppt
 * and the template and add-in types), launchers and scripts (exe, bat, cmd, ps1, lnk, url, scr,
 * msi, js, vbs, hta, jar, com, reg, ...), svg and html (they can run script in a viewer), rtf,
 * archives, and any type not listed here.
 */
export const OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'csv',
  'tsv',
  'log',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
])

export const REVEAL_NOTE =
  'Files of this type are not opened from a reply, because they could run code. It is shown in Explorer instead.'

/** The text of a line reference (`file.ts:42` or `file.ts:42:7`), which is not part of the name. */
const LINE_SUFFIX = /(?::\d{1,6}){1,2}$/

type Failure = { ok: false; reason: string }
const NOT_FOUND = 'That is not a file or folder inside a folder you have granted.'

/**
 * What to do with a file, from its REAL name (as the file system reports it, not as the reply
 * spelled it). Only the extension after the last dot counts, compared in ASCII lower case, so
 * `A.TXT` opens and `a.txt.exe`, `a.txt ` and `a.txt.lnk` do not. A name with a colon (an
 * alternate data stream) or a trailing dot or space (Windows drops those and runs the name
 * without them) is refused outright.
 */
export function classifyName(
  name: string,
  platform: NodeJS.Platform,
): { action: MentionAction; note?: string } | Failure {
  if (name.includes(':') && platform === 'win32')
    return { ok: false, reason: 'That name is not a plain file name.' }
  if (/[. ]$/.test(name) && platform === 'win32')
    return { ok: false, reason: 'That name ends with a dot or a space, which Windows ignores.' }
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  if (/^[A-Za-z0-9]+$/.test(extension) && OPEN_EXTENSIONS.has(extension.toLowerCase()))
    return { action: 'open' }
  return { action: 'reveal', note: REVEAL_NOTE }
}

type Proposal =
  | { ok: true; absolute: true; abs: string }
  | { ok: true; absolute: false; segments: string[] }
  | Failure

/** Most granted-folder candidates one relative text is checked against; more is not resolved. */
const MAX_CANDIDATES = 64

/** The shape of a proposed text, without touching the file system. */
function parseProposal(text: string, platform: NodeJS.Platform): Proposal {
  const bad: Failure = { ok: false, reason: NOT_FOUND }
  if (text.length === 0 || text.length > MENTION_MAX_TEXT) return bad
  if (CONTROL_CHARS.test(text) || BIDI_CONTROLS.test(text) || text.includes('"')) return bad
  let rest = text.replace(LINE_SUFFIX, '')
  if (platform === 'win32') rest = rest.replaceAll('\\', '/')
  rest = rest.replace(/\/+$/, '')
  if (rest === '') return bad
  const windows = platform === 'win32'
  const absolute = windows ? /^[A-Za-z]:\//.test(rest) : rest.startsWith('/')
  if (absolute) {
    const segments = rest.slice(windows ? 3 : 1).split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return bad
    const drive = windows ? `${rest.slice(0, 2)}\\` : '/'
    return { ok: true, absolute: true, abs: drive + segments.join(windows ? '\\' : '/') }
  }
  if (windows && (rest.startsWith('/') || /^[A-Za-z]:/.test(rest))) return bad
  while (rest.startsWith('./')) rest = rest.slice(2)
  const segments = rest.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return bad
  return { ok: true, absolute: false, segments }
}

export type MentionDecision =
  { ok: true; path: string; kind: 'file' | 'dir'; action: MentionAction; note?: string } | Failure

/**
 * Decides what a click on `text` would do, now. Never opens anything. Every failure (not a
 * path, outside the grants, missing, a link or alias, a hard link, a secret file, an odd name)
 * is `ok: false`; the callers do not tell them apart to the reply.
 */
export async function decideMention(
  guard: PathGuard,
  text: string,
  fs: ListFs = nodeListFs,
): Promise<MentionDecision> {
  const proposal = parseProposal(text, guard.platform)
  if (!proposal.ok) return proposal
  const roots = guard.grantedRoots()
  const P = guard.path

  // Each candidate is a granted folder and a relative path inside it.
  let direct: { root: string; rel: string }[]
  let fallback: { root: string; rel: string }[] = []
  if (proposal.absolute) {
    // Compared as text first: a path outside the grants is never looked at.
    const inside = roots
      .filter((root) => isInside(proposal.abs, root, guard.platform))
      .sort((a, b) => b.length - a.length)[0]
    if (inside === undefined) return { ok: false, reason: NOT_FOUND }
    direct = [{ root: inside, rel: P.relative(inside, proposal.abs).split(P.sep).join('/') }]
  } else {
    direct = roots.map((root) => ({ root, rel: proposal.segments.join('/') }))
    // `myproject/src/a.ts`, where `myproject` is the granted folder itself.
    const [first, ...tail] = proposal.segments
    if (first !== undefined && tail.length > 0)
      fallback = roots
        .filter((root) => (P.basename(root) || root).toLowerCase() === first.toLowerCase())
        .map((root) => ({ root, rel: tail.join('/') }))
  }

  // A relative text is tried in every granted folder, both as written and as `<folder name>/…`,
  // and a name that exists in two different places is not guessed. Too many candidates to try
  // them all is also not guessed: the text is plain.
  const candidates = [...direct, ...fallback]
  if (!proposal.absolute && candidates.length > MAX_CANDIDATES)
    return { ok: false, reason: NOT_FOUND }
  let lastFailure: Failure = { ok: false, reason: NOT_FOUND }
  const found = new Map<string, Checked & { ok: true }>()
  for (const { root, rel } of candidates) {
    const entry = await check(guard, { rootId: rootId(root), rel }, fs)
    if (entry.ok) found.set(entry.path, entry)
    else if (proposal.absolute) lastFailure = entry
  }
  if (found.size === 0) return lastFailure
  if (found.size > 1)
    return { ok: false, reason: 'That name matches files in more than one granted folder.' }
  const entry = [...found.values()][0]
  if (entry === undefined) return lastFailure
  if (entry.secret) return { ok: false, reason: SECRET_REVEAL }
  if (entry.isFile && entry.hardLink)
    return {
      ok: false,
      reason: 'This file has other hard links, so it is not opened from a reply.',
    }
  if (entry.isDir) return { ok: true, path: entry.path, kind: 'dir', action: 'open' }
  if (!entry.isFile) return { ok: false, reason: 'That is not a file or a folder.' }
  const how = classifyName(P.basename(entry.path), guard.platform)
  if ('ok' in how) return how
  return {
    ok: true,
    path: entry.path,
    kind: 'file',
    action: how.action,
    ...(how.note ? { note: how.note } : {}),
  }
}

/** The answer for the renderer: what a click would do, or nothing. Reveals no reason. */
export async function resolveMentions(
  guard: PathGuard,
  texts: readonly string[],
  fs: ListFs = nodeListFs,
): Promise<MentionResolution[]> {
  const out: MentionResolution[] = []
  for (const text of texts) {
    const decision = await decideMention(guard, text, fs)
    out.push(
      decision.ok
        ? {
            ok: true,
            path: decision.path,
            kind: decision.kind,
            action: decision.action,
            ...(decision.note ? { note: decision.note } : {}),
          }
        : { ok: false },
    )
  }
  return out
}

export interface MentionActs {
  /** Electron's shell.openPath: resolves to '' on success, else an error message. */
  open: (path: string) => Promise<string>
  /** Electron's shell.showItemInFolder. */
  reveal: (path: string) => void
  audit: AuditSink
}

/**
 * A click: decides again against the grants as they are now, then opens a folder or an
 * allowed file type, or shows anything else in Explorer. Each attempt is one audit entry (action,
 * path and result; never contents).
 */
export async function openMention(
  guard: PathGuard,
  text: string,
  acts: MentionActs,
  fs: ListFs = nodeListFs,
): Promise<MentionOpenResult> {
  const started = Date.now()
  const decision = await decideMention(guard, text, fs)
  const record = async (
    entry: { action: string; kind?: string; path?: string },
    outcome: 'ok' | 'error',
    error?: string,
  ): Promise<void> => {
    await acts.audit.record({
      tool: 'open_from_reply',
      args: { action: entry.action, ...(entry.kind ? { kind: entry.kind } : {}) },
      paths: entry.path ? [entry.path] : [],
      approval: 'not-requested',
      origin: 'user',
      outcome,
      ...(error ? { error } : {}),
      durationMs: Date.now() - started,
    })
  }
  if (!decision.ok) {
    await record({ action: 'refused' }, 'error', 'refused')
    return decision
  }
  const { path, kind, action } = decision
  const note = decision.note
  const shown = { action, kind, path }
  try {
    if (action === 'open') {
      const failure = await acts.open(path)
      if (failure) {
        await record(shown, 'error', 'open-failed')
        return {
          ok: false,
          reason: `Windows could not open it: ${failure.slice(0, 200)}`,
        }
      }
    } else {
      acts.reveal(path)
    }
  } catch {
    await record(shown, 'error', 'failed')
    return { ok: false, reason: 'That did not work.' }
  }
  await record(shown, 'ok')
  return { ok: true, path, action, ...(note ? { note } : {}) }
}
