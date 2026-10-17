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
  3: 'access to a process in the tree was denied',
  4: 'processes that may belong to the tree could not be identified, so they were left running',
}

/** Bounds, in ms since the epoch, of when a process was created: the clock just before and after spawning it. */
export interface SpawnWindow {
  after: number
  before: number
}

/** The process tree a fallback kill is for. */
export interface TreeKillTarget {
  /** The root process (the shell). */
  pid: number
  /** When the root was created; without it the root cannot be told from a process that reused its id. */
  started?: SpawnWindow | undefined
  /**
   * A time (ms since the epoch) at which the app still held the root's process handle,
   * so its id had not been reused yet; omitted if that is not known.
   */
  aliveAt?: number | undefined
}

/**
 * The fallback tree kill's input and output: list the processes, open (pin), kill and
 * wait for one, and the clock. treeKillScript defines them over WMI and .NET; the tests
 * replace them to drive TREE_KILL_CORE through exact snapshot sequences. Times are UTC.
 */
const TREE_KILL_IO = `$script:handles = @{}
function Get-TreeNow { [DateTime]::UtcNow }
function Get-TreeSnapshot {
  $searcher = [wmisearcher]'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process'
  $searcher.Options.Timeout = [TimeSpan]::FromSeconds(10)
  foreach ($p in $searcher.Get()) {
    $born = $null
    if ($p.CreationDate) { $born = [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime() }
    [pscustomobject]@{ Id = [int]$p.ProcessId; ParentId = [int]$p.ParentProcessId; Born = $born }
  }
}
function Open-TreeMember([int]$id, [DateTime]$born) {
  try { $p = [System.Diagnostics.Process]::GetProcessById($id) } catch { return 'gone' }
  try {
    # Holding the handle keeps the id from being reused; then check it is the same process.
    $null = $p.Handle
    $start = $p.StartTime.ToUniversalTime()
  } catch {
    try { $null = [System.Diagnostics.Process]::GetProcessById($id) } catch { return 'gone' }
    return 'denied'
  }
  if ([Math]::Abs(($start - $born).TotalMilliseconds) -ge 1) { $p.Dispose(); return 'gone' }
  $script:handles[$id] = $p
  'pinned'
}
function Stop-TreeMember([int]$id) {
  $p = $script:handles[$id]
  if ($p.HasExited) { return 'exited' }
  try { $p.Kill(); 'killed' } catch { if ($p.HasExited) { 'exited' } else { 'denied' } }
}
function Test-TreeMemberExited([int]$id) { $script:handles[$id].HasExited }
function Wait-TreeMember([int]$id, [int]$ms) { $null = $script:handles[$id].WaitForExit($ms) }
`

/**
 * The fallback tree kill's decisions, over the functions in TREE_KILL_IO. On any doubt
 * it leaves a process alone and does not report success.
 *
 * Every member of the tree has a creation time (Born) and a time up to which its id is
 * known to have still been that process (Until). A process is adopted as a member only
 * if its parent is a member and it was created after the parent and no later than the
 * parent's Until, so a process started by a newer owner of a dead member's id is never
 * taken for part of the tree. Members still running are pinned by opening a handle,
 * which keeps their id from being reused while the script runs (Until is then
 * unbounded), and only pinned members whose start time matches are killed.
 *
 * The root counts as the shell only if its creation time falls in the spawn window
 * (1 s before spawning to 100 ms after, for clock granularity). A root that has already
 * exited is never killed, but adopts the children it started up to aliveAt, when its
 * id was still held by the app; with no aliveAt, none.
 *
 * Doubts: a process whose parent is a member but whose creation time is unreadable, or
 * later than the parent's Until, a root that is running but cannot be identified, and a
 * member that cannot be opened or killed. Doubtful processes are never killed, and any
 * doubt makes the result non-zero. Each round re-lists the processes, so grandchildren
 * started while the tree is being killed are found and killed too.
 *
 * Returns 0 once a fresh snapshot shows no member running and nothing doubtful, 1 if
 * members are still running at the deadline, 2 if the processes cannot be listed, 3 if
 * access to a member was denied (as soon as a kill is denied), 4 on any other doubt.
 * Reasons go to stderr.
 */
export const TREE_KILL_CORE = `function ConvertFrom-TreeMs([long]$ms) {
  if ($ms -lt 0) { return $null }
  [DateTimeOffset]::FromUnixTimeMilliseconds($ms).UtcDateTime
}
function Invoke-TreeKill([int]$Root, [long]$BornAfter, [long]$BornBefore, [long]$AliveAt, [int]$Seconds) {
  $ErrorActionPreference = 'Stop'
  $forever = [DateTime]::MaxValue
  $after = ConvertFrom-TreeMs $BornAfter
  $before = ConvertFrom-TreeMs $BornBefore
  $alive = ConvertFrom-TreeMs $AliveAt
  $deadline = (Get-TreeNow).AddSeconds($Seconds)
  $members = @{}
  try {
    while ($true) {
      $at = Get-TreeNow
      $byId = @{}
      $children = @{}
      foreach ($p in @(Get-TreeSnapshot)) {
        $byId[$p.Id] = $p
        $children[$p.ParentId] += @($p)
      }
      if (-not $byId.ContainsKey($PID)) { throw 'the process list does not include this process' }
      $doubts = [System.Collections.Generic.List[string]]::new()
      $denied = $false
      if ($members.Count -eq 0) {
        $r = $byId[$Root]
        if ($r -and $r.Born -and $after -and $before -and $r.Born -ge $after.AddSeconds(-1) -and $r.Born -le $before.AddMilliseconds(100)) {
          $members[$Root] = @{ Born = $r.Born; Until = $at; Pinned = $false }
        } else {
          # Gone, or another process: children it started up to $alive are still its own.
          $proxy = if ($before) { $before } else { [DateTime]::MinValue }
          $members[$Root] = @{ Born = $proxy; Until = $(if ($alive -and $before) { $alive } else { $proxy }); Pinned = $false; Gone = $true }
          if ($r -and -not ($r.Born -and $after -and $before)) { $doubts.Add("process $Root is running but cannot be identified as the shell") }
        }
      }
      foreach ($id in @($members.Keys)) {
        $m = $members[$id]
        $p = $byId[$id]
        if (-not $m.Pinned -and -not $m.Gone -and $p -and $p.Born -eq $m.Born) { $m.Until = $at }
      }
      do {
        $added = $false
        foreach ($id in @($members.Keys)) {
          $m = $members[$id]
          foreach ($c in $children[$id]) {
            if ($c.Id -eq $id -or $members.ContainsKey($c.Id) -or -not $c.Born) { continue }
            if ($c.Born -le $m.Born -or $c.Born -gt $m.Until) { continue }
            $members[$c.Id] = @{ Born = $c.Born; Until = $at; Pinned = $false }
            $added = $true
          }
        }
      } while ($added)
      foreach ($id in @($members.Keys)) {
        $m = $members[$id]
        foreach ($c in $children[$id]) {
          if ($c.Id -eq $id -or $members.ContainsKey($c.Id)) { continue }
          if (-not $c.Born) { $doubts.Add("process $($c.Id), started by $id, has no readable start time") }
          elseif ($c.Born -gt $m.Born -and $c.Born -gt $m.Until) { $doubts.Add("process $($c.Id) was started by $id after its id may have been reused") }
        }
        $p = $byId[$id]
        if ($m.Gone -or $m.Pinned -or -not $p -or $p.Born -ne $m.Born) { continue }
        switch (Open-TreeMember $id $m.Born) {
          'pinned' { $m.Pinned = $true; $m.Until = $forever }
          'denied' { $denied = $true; $doubts.Add("process $id cannot be opened: access denied") }
        }
      }
      $live = @(foreach ($id in @($members.Keys)) { if ($members[$id].Pinned -and -not (Test-TreeMemberExited $id)) { $id } })
      if ($live.Count -eq 0) {
        foreach ($d in $doubts) { [Console]::Error.WriteLine($d) }
        if ($denied) { return 3 }
        if ($doubts.Count -gt 0) { return 4 }
        return 0
      }
      foreach ($id in $live) {
        if ((Stop-TreeMember $id) -eq 'denied') {
          [Console]::Error.WriteLine("process $id cannot be killed: access denied")
          return 3
        }
      }
      if ((Get-TreeNow) -gt $deadline) { return 1 }
      foreach ($id in $live) {
        $left = [int](($deadline - (Get-TreeNow)).TotalMilliseconds)
        if ($left -le 0) { break }
        Wait-TreeMember $id $left
      }
    }
  } catch {
    [Console]::Error.WriteLine("tree kill failed: $_")
    return 2
  }
}
`

/**
 * The script for the fallback tree kill of `target` (see TREE_KILL_CORE), for when
 * taskkill is missing or fails.
 *
 * It uses only WMI and .NET, no cmdlets from modules: started with the minimal
 * environment the killer gets, PowerShell has no module cache and spends tens of
 * seconds "preparing modules for first use" before a cmdlet like Get-CimInstance runs.
 */
export function treeKillScript(target: TreeKillTarget): string {
  const { pid, started, aliveAt } = target
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`)
  const ms = (value: number | undefined): string =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? String(value) : '-1'
  return (
    `${TREE_KILL_IO}${TREE_KILL_CORE}` +
    `$code = Invoke-TreeKill -Root ${String(pid)} -BornAfter ${ms(started?.after)} ` +
    `-BornBefore ${ms(started?.before)} -AliveAt ${ms(aliveAt)} -Seconds ${String(TREE_KILL_SECONDS)}\n` +
    'exit [int]@($code)[-1]\n'
  )
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
