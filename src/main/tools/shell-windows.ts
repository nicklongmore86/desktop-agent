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

/** How long the fallback tree kill keeps killing and re-checking before it gives up. */
export const TREE_KILL_SECONDS = 8

/** Exit codes of treeKillScript other than 0 (every process in the tree has exited). */
export const TREE_KILL_EXIT: Readonly<Record<number, string>> = {
  1: `processes in the tree were still running after ${String(TREE_KILL_SECONDS)} s`,
  2: 'it could not list the running processes',
}

/**
 * Kills `pid` and every process descended from it, for when taskkill is missing or
 * fails, and exits 0 only once a fresh snapshot shows that none of them is running.
 *
 * Each round takes a snapshot of all processes, adds to the tree every process whose
 * parent is in it (including a parent that has exited, so a grandchild started while
 * the tree was being killed is found too), kills the members still running and waits
 * for them. A member is known by its id and creation time: a child created before its
 * parent, or after another process took over its parent's id, is not part of the tree,
 * and a process that reused a member's id is never killed. It exits 1 if members are
 * still running after TREE_KILL_SECONDS, and 2 if the processes cannot be listed, rather
 * than reporting a partial kill as success.
 *
 * It uses only WMI and .NET, no cmdlets from modules: started with the minimal
 * environment the killer gets, PowerShell has no module cache and spends tens of
 * seconds "preparing modules for first use" before a cmdlet like Get-CimInstance runs.
 */
export function treeKillScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`)
  return `$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(${String(TREE_KILL_SECONDS)})
$root = ${String(pid)}
# Every process found in the tree: id -> creation time ($null for a root already gone).
$tree = @{}
try {
  while ($true) {
    $searcher = [wmisearcher]'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process'
    $searcher.Options.Timeout = [TimeSpan]::FromSeconds(${String(TREE_KILL_SECONDS)})
    $byId = @{}
    $children = @{}
    foreach ($p in $searcher.Get()) {
      $born = $null
      if ($p.CreationDate) { $born = [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate) }
      $entry = [pscustomobject]@{ Id = [int]$p.ProcessId; Born = $born }
      $byId[$entry.Id] = $entry
      $children[[int]$p.ParentProcessId] += @($entry)
    }
    if (-not $byId.ContainsKey($PID)) { throw 'the process list does not include this process' }
    if ($tree.Count -eq 0) { $tree[$root] = if ($byId[$root]) { $byId[$root].Born } else { $null } }
    $queue = [System.Collections.Generic.Queue[int]]::new()
    foreach ($id in @($tree.Keys)) { $queue.Enqueue($id) }
    while ($queue.Count -gt 0) {
      $id = $queue.Dequeue()
      $born = $tree[$id]
      $now = $byId[$id]
      # Children of a newer process that took over this id are not in the tree.
      $reusedAt = $null
      if ($now -and $now.Born -ne $born) { $reusedAt = $now.Born }
      foreach ($c in $children[$id]) {
        if ($c.Id -eq $id -or $tree.ContainsKey($c.Id)) { continue }
        if ($born -and -not ($c.Born -ge $born)) { continue }
        if ($reusedAt -and $c.Born -ge $reusedAt) { continue }
        $tree[$c.Id] = $c.Born
        $queue.Enqueue($c.Id)
      }
    }
    $live = @(foreach ($id in @($tree.Keys)) {
      if ($tree[$id] -and $byId[$id] -and $byId[$id].Born -eq $tree[$id]) { $id }
    })
    if ($live.Count -eq 0) { exit 0 }
    $killed = @(foreach ($id in $live) {
      try {
        $p = [System.Diagnostics.Process]::GetProcessById($id)
        # The process in the snapshot, not a newer one that reused its id.
        if ([Math]::Abs(($p.StartTime - $tree[$id]).TotalMilliseconds) -lt 1) { $p.Kill(); $p }
      } catch {}
    })
    if ([DateTime]::UtcNow -gt $deadline) { exit 1 }
    foreach ($p in $killed) {
      $left = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
      if ($left -le 0) { break }
      try { $null = $p.WaitForExit($left) } catch {}
    }
  }
} catch {
  [Console]::Error.WriteLine("tree kill failed: $_")
  exit 2
}
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
