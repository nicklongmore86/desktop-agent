import { promises as fs } from 'node:fs'
import { sniff } from '../documents/sniff'
import { UNSAFE_TITLE_CHARS } from '../storage/plain-text'
import { ToolFailure, ToolInputError, type RunResult, type ToolCall, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { globToRegExp } from './glob'
import { PatternMatcher, type MatchOutcome, type PatternSource } from './matcher'
import { readableAsDocument } from './read-document'
import { openVerified, readBounded } from './safe-fs'
import { clip, decodeText, formatBytes, splitLines } from './text'
import { walk, type WalkEntry } from './walk'

interface Input {
  path: string
  namePattern: string | undefined
  contentPattern: string | undefined
  regex: boolean
  caseSensitive: boolean
  maxResults: number
  maxDepth: number
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules'])
const MAX_PATTERN_LENGTH = 500
/** Lines longer than this are cut before matching, bounding the work per line. */
const MAX_MATCH_LINE = 4000
/** Entries are name-matched in batches of this size, one worker round trip each. */
const BATCH = 256

const NAME = 0
const CONTENT = 1

/** How many skipped files a content search names; the rest are only counted. */
export const MAX_SKIPPED_LISTED = 50

/**
 * Extensions of files read_document opens, for ranking skipped files and for files too
 * large to open (whose bytes are never sniffed). Not .ppt, which it cannot read.
 */
const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'docm',
  'xls',
  'xlsx',
  'xlsm',
  'pptx',
  'odt',
  'ods',
  'odp',
  'csv',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'avif',
  'heic',
  'heif',
])

type SkipReason = 'document' | 'binary' | 'too-large' | 'hard-link' | 'unreadable'

const SKIP_LABEL: Record<SkipReason, string> = {
  document: 'document, not searched',
  binary: 'binary, not searched',
  'too-large': 'too large',
  'hard-link': 'hard-linked',
  unreadable: 'unreadable',
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** A path as one line of plain text: control, bidi and other invisible characters become U+FFFD. */
export function safeRel(rel: string): string {
  return rel.replace(UNSAFE_TITLE_CHARS, '\uFFFD')
}

/** Words of a content pattern worth looking for in skipped file names (cheap, not a parse). */
export function queryTerms(pattern: string | undefined): string[] {
  if (pattern === undefined) return []
  const words = pattern.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  return [...new Set(words)]
}

export function searchFilesTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { limits } = deps
  return {
    name: 'search_files',
    description:
      'Search a folder inside the granted folders by file name (glob, e.g. "*.ts" or "src/**/*.md") ' +
      'and/or by file content (substring, or a JavaScript regex with regex: true). Case-insensitive ' +
      'unless caseSensitive is true. Name-only searches list matching names of any file, binary ' +
      'included. Content search covers plain text only: matches are returned as "path:line: text" ' +
      'and never come from PDFs, Office files, images or other binary files, files over ' +
      `${formatBytes(limits.maxReadBytes)} or files with several hard links; skipped files are ` +
      'counted by reason and the likeliest documents named, to open with read_document. Skips ' +
      '.git, node_modules and protected files. Stops after maxResults ' +
      `(default ${String(limits.defaultSearchResults)}), ${String(limits.searchTimeMs / 1000)} s, or ` +
      `${String(limits.maxSearchEntries)} entries visited.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the folder to search.' },
        namePattern: {
          type: 'string',
          description:
            'Glob matched against the file name, or against the relative path if it contains "/".',
        },
        contentPattern: { type: 'string', description: 'Text (or regex) to find inside files.' },
        regex: { type: 'boolean', description: 'Treat contentPattern as a regex (default false).' },
        caseSensitive: { type: 'boolean', description: 'Default false.' },
        maxResults: { type: 'integer', minimum: 1, maximum: limits.maxSearchResults },
        maxDepth: { type: 'integer', minimum: 1, maximum: limits.maxSearchDepth },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needsApproval: false,
    parse(input) {
      const namePattern = input.optionalString('namePattern')
      const contentPattern = input.optionalString('contentPattern')
      if (!namePattern && !contentPattern) {
        throw new ToolInputError('give "namePattern", "contentPattern" or both.')
      }
      for (const [key, value] of [
        ['namePattern', namePattern],
        ['contentPattern', contentPattern],
      ]) {
        if (value !== undefined && value.length > MAX_PATTERN_LENGTH) {
          throw new ToolInputError(
            `"${key ?? ''}" is longer than ${String(MAX_PATTERN_LENGTH)} characters.`,
          )
        }
      }
      const regex = input.optionalBoolean('regex') ?? false
      const caseSensitive = input.optionalBoolean('caseSensitive') ?? false
      if (contentPattern && regex) {
        try {
          // Compiling is linear-time and safe here; matching runs in the worker.
          new RegExp(contentPattern, caseSensitive ? 'u' : 'iu')
        } catch (error) {
          throw new ToolInputError(`invalid regex: ${(error as Error).message}`)
        }
      }
      return {
        path: input.string('path'),
        namePattern,
        contentPattern,
        regex,
        caseSensitive,
        maxResults:
          input.optionalInteger('maxResults', 1, limits.maxSearchResults) ??
          limits.defaultSearchResults,
        maxDepth:
          input.optionalInteger('maxDepth', 1, limits.maxSearchDepth) ?? limits.maxSearchDepth,
      }
    },
    // Patterns can carry anything (even secrets the model has seen): only their shape is logged.
    summarize: (input) => ({
      path: input.path,
      ...(input.namePattern !== undefined
        ? { namePattern: { kind: 'glob', length: input.namePattern.length } }
        : {}),
      ...(input.contentPattern !== undefined
        ? {
            contentPattern: {
              kind: input.regex ? 'regex' : 'substring',
              length: input.contentPattern.length,
            },
          }
        : {}),
      caseSensitive: input.caseSensitive,
      maxResults: input.maxResults,
      maxDepth: input.maxDepth,
    }),
    run: (input, call) => runSearch(input, call, deps),
  }
}

async function runSearch(input: Input, call: ToolCall, deps: ResolvedDeps): Promise<RunResult> {
  const { limits } = deps
  const { path: dir, exists } = await call.resolve(input.path)
  if (!exists || !(await fs.stat(dir)).isDirectory()) {
    throw new ToolFailure(`Not a folder: ${dir}`, 'not-a-folder')
  }

  const patterns: PatternSource[] = [
    {
      source: input.namePattern ? globToRegExp(input.namePattern, true).source : '',
      flags: input.caseSensitive ? '' : 'i',
    },
    {
      source: input.contentPattern && input.regex ? input.contentPattern : '',
      flags: input.caseSensitive ? 'u' : 'iu',
    },
  ]
  const matchFullPath = input.namePattern ? /[\\/]/.test(input.namePattern) : false
  const substring = input.contentPattern && !input.regex ? input.contentPattern : null
  const signal = call.ctx.signal
  const deadline = deps.now() + limits.searchTimeMs
  const timeLeft = (): number => Math.max(0, deadline - deps.now())

  const results: string[] = []
  let visited = 0
  let unreadable = 0
  let hidden = 0
  const skips: Record<SkipReason, number> = {
    document: 0,
    binary: 0,
    'too-large': 0,
    'hard-link': 0,
    unreadable: 0,
  }
  // Skipped files to name, best first: documents whose name has a query term, other
  // documents, then the rest. Each tier keeps its first MAX_SKIPPED_LISTED in walk order.
  const tiers: string[][] = [[], [], []]
  const terms = queryTerms(input.contentPattern)
  const skip = (entry: WalkEntry, reason: SkipReason): void => {
    skips[reason]++
    const document = reason === 'document' || DOCUMENT_EXTENSIONS.has(extensionOf(entry.name))
    const named = terms.some((t) => entry.rel.toLowerCase().includes(t))
    const tier = tiers[document ? (named ? 0 : 1) : 2] ?? []
    if (tier.length >= MAX_SKIPPED_LISTED) return
    const detail =
      reason === 'too-large' ? `too large, ${formatBytes(entry.size)}` : SKIP_LABEL[reason]
    tier.push(
      `  ${safeRel(entry.rel)} (${document && reason !== 'document' ? `document, ${detail}` : detail})`,
    )
  }
  // An object so TypeScript does not narrow it across the helpers that set it.
  const state: { stop: string | null } = { stop: null }
  const stopFor = (outcome: MatchOutcome): string =>
    outcome.kind === 'timeout'
      ? `reached the ${String(limits.searchTimeMs / 1000)} s time limit (a slow pattern is stopped there)`
      : outcome.kind === 'cancelled'
        ? 'cancelled'
        : 'the pattern could not be run'

  const needsWorker = input.namePattern !== undefined || patterns[CONTENT]?.source !== ''
  const matcher = needsWorker ? new PatternMatcher(patterns) : null

  /** Matching line numbers of one file, or null when the search must stop. */
  async function contentHits(entry: WalkEntry): Promise<string[] | null> {
    if (entry.nlink > 1) {
      skip(entry, 'hard-link')
      return []
    }
    if (entry.size > limits.maxReadBytes) {
      skip(entry, 'too-large')
      return []
    }
    let bytes: Buffer
    try {
      const { handle } = await openVerified(deps.guard, entry.path, 'read', entry.id)
      try {
        bytes = await readBounded(handle, limits.maxReadBytes)
      } finally {
        await handle.close()
      }
    } catch (error) {
      // The handle's own link count can catch a hard link the listing missed.
      skip(
        entry,
        error instanceof ToolFailure && error.code === 'hard-link' ? 'hard-link' : 'unreadable',
      )
      return []
    }
    const decoded = decodeText(bytes)
    if (decoded.binary) {
      skip(entry, readableAsDocument(sniff(bytes).kind) ? 'document' : 'binary')
      return []
    }
    const lines = splitLines(decoded.text).map((l) => l.slice(0, MAX_MATCH_LINE))
    const room = input.maxResults - results.length
    let hits: number[] = []
    if (substring !== null) {
      const needle = input.caseSensitive ? substring : substring.toLowerCase()
      for (let i = 0; i < lines.length && hits.length < room; i++) {
        const line = lines[i] ?? ''
        if ((input.caseSensitive ? line : line.toLowerCase()).includes(needle)) hits.push(i)
      }
    } else if (matcher) {
      const outcome = await matcher.match(CONTENT, lines, room, timeLeft(), signal)
      if (outcome.kind !== 'ok') {
        state.stop = stopFor(outcome)
        return null
      }
      hits = outcome.hits
    }
    return hits.map((i) => `${entry.rel}:${String(i + 1)}: ${clip((lines[i] ?? '').trim(), 200)}`)
  }

  async function processBatch(batch: WalkEntry[]): Promise<void> {
    let candidates = batch
    if (input.namePattern !== undefined && matcher) {
      const names = batch.map((e) => (matchFullPath ? e.rel : e.name))
      const outcome = await matcher.match(NAME, names, names.length, timeLeft(), signal)
      if (outcome.kind !== 'ok') {
        state.stop = stopFor(outcome)
        return
      }
      candidates = outcome.hits.flatMap((i) => (batch[i] ? [batch[i]] : []))
    }
    for (const entry of candidates) {
      if (results.length >= input.maxResults) break
      if (signal.aborted) {
        state.stop = 'cancelled'
        return
      }
      if (input.contentPattern === undefined) {
        results.push(entry.kind === 'dir' ? `${entry.rel}/` : entry.rel)
      } else if (entry.kind === 'file') {
        if (timeLeft() === 0) {
          state.stop = stopFor({ kind: 'timeout' })
          return
        }
        const hits = await contentHits(entry)
        if (hits === null) return
        results.push(...hits)
      }
    }
    if (results.length >= input.maxResults) {
      state.stop = `reached maxResults (${String(input.maxResults)})`
    }
  }

  try {
    let batch: WalkEntry[] = []
    for await (const entry of walk(dir, deps.guard, {
      maxDepth: input.maxDepth,
      signal,
      skipDirs: SKIPPED_DIRS,
      onBlocked: () => hidden++,
      onError: () => unreadable++,
    })) {
      if (++visited > limits.maxSearchEntries) {
        state.stop = `visited ${String(limits.maxSearchEntries)} entries`
        break
      }
      if (timeLeft() === 0) {
        state.stop = stopFor({ kind: 'timeout' })
        break
      }
      batch.push(entry)
      if (batch.length >= BATCH) {
        await processBatch(batch)
        batch = []
        if (state.stop !== null) break
      }
    }
    if (state.stop === null && batch.length > 0) await processBatch(batch)
  } finally {
    await matcher?.close()
  }
  call.throwIfAborted()

  const notes: string[] = []
  if (state.stop !== null) {
    notes.push(
      `Search stopped early: ${state.stop}. Results are partial: files after that point were ` +
        'neither searched nor counted below. Narrow the folder or pattern for more.',
    )
  }
  const skippedTotal = Object.values(skips).reduce((a, b) => a + b, 0)
  if (skippedTotal > 0) {
    const counts = (Object.keys(SKIP_LABEL) as SkipReason[])
      .filter((reason) => skips[reason] > 0)
      .map((reason) => `${String(skips[reason])} ${SKIP_LABEL[reason]}`)
    notes.push(`${String(skippedTotal)} files skipped: ${counts.join('; ')}.`)
    const listed = tiers.flat().slice(0, MAX_SKIPPED_LISTED)
    notes.push(...listed)
    if (skippedTotal > listed.length) {
      notes.push(`  …and ${String(skippedTotal - listed.length)} more not listed.`)
    }
  }
  if (tiers[0]?.length || tiers[1]?.length) {
    notes.push(
      'PDFs, Word, Excel and PowerPoint files and images are not searched by content: open the ' +
        'likely ones above with read_document.',
    )
  }
  if (hidden > 0) notes.push(`${String(hidden)} protected entries hidden.`)
  if (unreadable > 0) notes.push(`${String(unreadable)} entries could not be read.`)
  const header = `${String(results.length)} result${results.length === 1 ? '' : 's'} in ${dir}`
  return { content: [header, ...results, ...notes].join('\n') }
}
