// Windows PowerShell specifics for run_shell: exact command encoding, UTF-8 output and a
// fallback process-tree kill.

/**
 * Prepended to every command. Windows PowerShell 5.1 writes redirected output in the
 * console's OEM codepage, so non-ASCII text arrives garbled; this switches stdout and
 * stderr (and text piped to native programs) to UTF-8 without a BOM.
 */
export const UTF8_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = [Console]::OutputEncoding'

/**
 * A script as a `-EncodedCommand` argument: base64 of its UTF-16LE text. The argument
 * holds only [A-Za-z0-9+/=], so no command-line quoting or escaping can change the
 * script between approval and execution.
 */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** The script `-EncodedCommand` runs for an approved command: the preamble, then the command verbatim. */
export function powerShellScript(command: string): string {
  return `${UTF8_PREAMBLE}\n${command}`
}

/**
 * Kills `pid` and every process descended from it, for when taskkill is missing or
 * fails. Walks parent ids from a single snapshot, only through children created after
 * their parent (so a reused parent id cannot pull in unrelated processes), stops every
 * process in the tree and exits 1 if any of them is still running afterwards.
 */
export function treeKillScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`)
  return `$ErrorActionPreference = 'SilentlyContinue'
$all = @(Get-CimInstance -ClassName Win32_Process)
$byId = @{}
$children = @{}
foreach ($p in $all) {
  $byId[[int]$p.ProcessId] = $p
  $children[[int]$p.ParentProcessId] += @($p)
}
$tree = [System.Collections.Generic.List[int]]::new()
$queue = [System.Collections.Generic.Queue[int]]::new()
$queue.Enqueue(${String(pid)})
while ($queue.Count -gt 0) {
  $id = $queue.Dequeue()
  if ($tree.Contains($id)) { continue }
  $tree.Add($id)
  $parent = $byId[$id]
  foreach ($c in $children[$id]) {
    $cid = [int]$c.ProcessId
    if ($cid -eq $id) { continue }
    if ($parent -and $c.CreationDate -and $parent.CreationDate -and $c.CreationDate -lt $parent.CreationDate) { continue }
    $queue.Enqueue($cid)
  }
}
foreach ($id in $tree) { Stop-Process -Id $id -Force }
$alive = 0
foreach ($id in $tree) {
  $p = Get-Process -Id $id
  if ($p -and -not $p.WaitForExit(2000)) { $alive++ }
}
exit [int]($alive -gt 0)
`
}

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

/** A Unicode scalar value: in range and not a surrogate, so String.fromCodePoint accepts it. */
function isScalarValue(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[a-z]+);/g, (entity, name: string) => {
      if (name.startsWith('#')) {
        const code = name.startsWith('#x')
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10)
        return isScalarValue(code) ? String.fromCodePoint(code) : entity
      }
      return XML_ENTITIES[name] ?? entity
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
}

const STREAM_PREFIX: Record<string, string> = {
  warning: 'WARNING: ',
  verbose: 'VERBOSE: ',
  debug: 'DEBUG: ',
}

/** Where a fragment was cut out of longer output, for decodeCliXml. */
export interface Cut {
  /** Text before this fragment was dropped. */
  start?: boolean
  /** Text after this fragment was dropped. */
  end?: boolean
}

const looksLikeCliXml = (text: string): boolean =>
  text.includes('#< CLIXML') ||
  text.includes('<Objs ') ||
  text.includes('</Objs>') ||
  text.includes('<S S="') ||
  text.includes('</S>')

/** Removes `pattern`'s match only when it sits right at the cut. */
const trimAt = (text: string, pattern: RegExp): string => text.replace(pattern, '')

/**
 * Makes a CLIXML fragment whose end was cut off well formed: drops a partial tag,
 * escape or entity, and a progress record that was cut off, then closes a cut-off stream
 * string so the part that was kept still decodes.
 */
function repairEnd(text: string): string {
  text = trimAt(text, /<[^<>]*$/)
  const progress = text.lastIndexOf('<Obj S="progress"')
  if (progress > text.lastIndexOf('</Obj>')) text = text.slice(0, progress)
  text = trimAt(text, /_x[0-9A-Fa-f]{0,4}$/)
  text = trimAt(text, /&#?[0-9A-Za-z]{0,8}$/)
  return text.lastIndexOf('<S S="') > text.lastIndexOf('</S>') ? `${text}</S>` : text
}

/**
 * Makes a CLIXML fragment whose start was cut off well formed: drops a partial tag,
 * the rest of a progress record, and a partial escape or entity, then opens a stream
 * string whose opening tag was cut off (its stream is unknown, so it gets no prefix).
 */
function repairStart(text: string): string {
  const firstOpen = text.indexOf('<')
  const firstClose = text.indexOf('>')
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
    text = text.slice(firstClose + 1)
  }
  const objEnd = text.indexOf('</Obj>')
  if (objEnd !== -1) {
    const objStart = text.indexOf('<Obj ')
    const stringStart = text.indexOf('<S S="')
    if ((objStart === -1 || objEnd < objStart) && (stringStart === -1 || objEnd < stringStart)) {
      text = text.slice(objEnd + '</Obj>'.length)
    }
  }
  text = trimAt(text, /^(x?[0-9A-Fa-f]{1,4}_|#?x?[0-9A-Fa-f]{1,8};|[a-z]{1,4};)/)
  const stringEnd = text.indexOf('</S>')
  const stringStart = text.indexOf('<S S="')
  return stringEnd !== -1 && (stringStart === -1 || stringEnd < stringStart)
    ? `<S S="">${text}`
    : text
}

/**
 * Windows PowerShell 5.1 started with -EncodedCommand writes its error, warning and
 * progress streams to a redirected stderr as CLIXML ("#< CLIXML" then <Objs>…</Objs>),
 * whatever -OutputFormat says. This turns that back into the text a console would show:
 * stream strings are decoded, progress records dropped, and anything else (such as a
 * native program's own stderr) left as it is. `cut` says which ends of `text` were cut
 * out of longer output; markup broken by the cut is repaired or dropped there, so no raw
 * XML or half-decoded escape is shown next to the omission marker.
 */
export function decodeCliXml(text: string, cut: Cut = {}): string {
  if (!looksLikeCliXml(text)) return text
  if (cut.end) text = repairEnd(text)
  if (cut.start) text = repairStart(text)
  return text
    .replace(/#< CLIXML\r?\n?/g, '')
    .replace(/<Obj S="progress"[\s\S]*?<\/Obj>/g, '')
    .replace(/<S S="([^"]*)">([\s\S]*?)<\/S>/g, (_, stream: string, body: string) => {
      const decoded = decodeXmlText(body)
      const prefix = STREAM_PREFIX[stream.toLowerCase()]
      if (prefix === undefined) return decoded
      return prefix + decoded + (decoded.endsWith('\n') ? '' : '\n')
    })
    .replace(/<Objs [^>]*>|<\/Objs>/g, '')
}
