import { promises as fs } from 'node:fs'
import { redactSecrets } from '../permissions/audit'
import { ToolFailure, ToolInputError, type ToolSpec } from './define'
import type { ResolvedDeps } from './deps'
import { globToRegExp } from './glob'
import { clip, decodeText, formatBytes, splitLines } from './text'
import { walk } from './walk'

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
/** Lines longer than this are cut before matching, bounding regex work per line. */
const MAX_MATCH_LINE = 4000

/**
 * Rejects regexes with a quantified group that itself contains a quantifier,
 * e.g. `(a+)+` or `(\w*)*`: the classic catastrophic-backtracking shape, which
 * would freeze the main process. A heuristic, not a proof.
 */
function hasNestedQuantifier(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/.test(pattern)
}

export function searchFilesTool(deps: ResolvedDeps): ToolSpec<Input> {
  const { limits } = deps
  return {
    name: 'search_files',
    description:
      'Search a folder inside the granted folders by file name (glob, e.g. "*.ts" or "src/**/*.md") ' +
      'and/or by file content (substring, or a JavaScript regex with regex: true). Case-insensitive ' +
      'unless caseSensitive is true. Content matches are returned as "path:line: text". Skips ' +
      `.git, node_modules, binary files, files over ${formatBytes(limits.maxReadBytes)} and protected files. Stops after maxResults ` +
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
      return {
        path: input.string('path'),
        namePattern,
        contentPattern,
        regex: input.optionalBoolean('regex') ?? false,
        caseSensitive: input.optionalBoolean('caseSensitive') ?? false,
        maxResults:
          input.optionalInteger('maxResults', 1, limits.maxSearchResults) ??
          limits.defaultSearchResults,
        maxDepth:
          input.optionalInteger('maxDepth', 1, limits.maxSearchDepth) ?? limits.maxSearchDepth,
      }
    },
    summarize: (input) => ({
      path: input.path,
      ...(input.namePattern !== undefined ? { namePattern: redactSecrets(input.namePattern) } : {}),
      ...(input.contentPattern !== undefined
        ? { contentPattern: redactSecrets(input.contentPattern) }
        : {}),
      regex: input.regex,
      caseSensitive: input.caseSensitive,
      maxResults: input.maxResults,
      maxDepth: input.maxDepth,
    }),
    async run(input, call) {
      const nameRe = input.namePattern ? globToRegExp(input.namePattern, input.caseSensitive) : null
      const matchFullPath = input.namePattern ? /[\\/]/.test(input.namePattern) : false
      const lineMatches = compileContentMatcher(input)

      const { path: dir, exists } = await call.resolve(input.path)
      if (!exists || !(await fs.stat(dir)).isDirectory())
        throw new ToolFailure(`Not a folder: ${dir}`)

      const deadline = deps.now() + limits.searchTimeMs
      const results: string[] = []
      let visited = 0
      let skipped = 0
      let stop: string | null = null
      for await (const entry of walk(dir, deps.guard, {
        maxDepth: input.maxDepth,
        signal: call.ctx.signal,
        skipDirs: SKIPPED_DIRS,
      })) {
        if (++visited > limits.maxSearchEntries) {
          stop = `visited ${String(limits.maxSearchEntries)} entries`
          break
        }
        if (deps.now() > deadline) {
          stop = `reached the ${String(limits.searchTimeMs / 1000)} s time limit`
          break
        }
        if (nameRe && !nameRe.test(matchFullPath ? entry.rel : entry.name)) continue
        if (!lineMatches) {
          results.push(entry.kind === 'dir' ? `${entry.rel}/` : entry.rel)
        } else if (entry.kind === 'file') {
          if (entry.size > limits.maxReadBytes) {
            skipped++
            continue
          }
          let decoded
          try {
            decoded = decodeText(await fs.readFile(entry.path))
          } catch {
            skipped++
            continue
          }
          if (decoded.binary) continue
          const lines = splitLines(decoded.text)
          for (let i = 0; i < lines.length && results.length < input.maxResults; i++) {
            const line = (lines[i] ?? '').slice(0, MAX_MATCH_LINE)
            if (lineMatches(line))
              results.push(`${entry.rel}:${String(i + 1)}: ${clip(line.trim(), 200)}`)
          }
        }
        if (results.length >= input.maxResults) {
          stop = `reached maxResults (${String(input.maxResults)})`
          break
        }
      }
      call.throwIfAborted()

      const notes: string[] = []
      if (stop) notes.push(`Search stopped early: ${stop}. Narrow the folder or pattern for more.`)
      if (skipped > 0) notes.push(`${String(skipped)} files skipped (too large or unreadable).`)
      const header = `${String(results.length)} result${results.length === 1 ? '' : 's'} in ${dir}`
      return { content: [header, ...results, ...notes].join('\n') }
    },
  }
}

function compileContentMatcher(input: Input): ((line: string) => boolean) | null {
  const pattern = input.contentPattern
  if (!pattern) return null
  if (!input.regex) {
    if (input.caseSensitive) return (line) => line.includes(pattern)
    const lower = pattern.toLowerCase()
    return (line) => line.toLowerCase().includes(lower)
  }
  if (hasNestedQuantifier(pattern)) {
    throw new ToolInputError(
      'regex has a nested quantifier such as (a+)+, which can take forever; simplify it.',
    )
  }
  let re: RegExp
  try {
    re = new RegExp(pattern, input.caseSensitive ? 'u' : 'iu')
  } catch (error) {
    throw new ToolInputError(`invalid regex: ${(error as Error).message}`)
  }
  return (line) => re.test(line)
}
