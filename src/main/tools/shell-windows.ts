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

function decodeXmlText(text: string): string {
  return text
    .replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[a-z]+);/g, (entity, name: string) => {
      if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
      if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
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

/**
 * Windows PowerShell 5.1 started with -EncodedCommand writes its error, warning and
 * progress streams to a redirected stderr as CLIXML ("#< CLIXML" then <Objs>…</Objs>),
 * whatever -OutputFormat says. This turns that back into the text a console would show:
 * stream strings are decoded, progress records dropped, and anything else (such as a
 * native program's own stderr) left as it is. Works on fragments too, since long output
 * is cut in the middle.
 */
export function decodeCliXml(text: string): string {
  if (!text.includes('#< CLIXML') && !text.includes('<Objs ') && !text.includes('<S S="')) {
    return text
  }
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
