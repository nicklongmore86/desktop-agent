import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TREE_KILL_CORE, TREE_KILL_EXIT } from './shell-windows'

// The fallback tree kill's decisions (TREE_KILL_CORE), run in real PowerShell against
// scripted process snapshots: Windows PowerShell on Windows, pwsh elsewhere if installed.

const POWERSHELL =
  process.platform === 'win32'
    ? path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      )
    : (process.env['PWSH'] ?? 'pwsh')
const available = spawnSync(POWERSHELL, ['-NoProfile', '-Command', 'exit 0']).status === 0

/** A process in a scripted snapshot. Times are ms since the epoch; born null is unreadable. */
interface Proc {
  id: number
  parent: number
  born: number | null
  /** Opening it is denied. */
  openDenied?: boolean
  /** Its id was taken over by another process before it could be opened. */
  takenOver?: boolean
  /** Killing it is denied. */
  killDenied?: boolean
  /** It is killed but never exits. */
  unkillable?: boolean
}

interface Scenario {
  root: number
  bornAfter: number
  bornBefore: number
  aliveAt: number
  /** One per round; the last repeats. Killed processes drop out of later ones. */
  snapshots: Proc[][]
  failSnapshot?: boolean
}

// The mocks: the clock advances 100 ms per reading, starting 10 s after the spawn.
const MOCK_IO = `$script:clock = [long]$spec.now
$script:round = 0
$script:current = @()
$script:pinned = @{}
$script:dead = @{}
$script:killed = [System.Collections.Generic.List[int]]::new()
function ConvertFrom-SpecMs($v) { if ($null -eq $v) { $null } else { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$v).UtcDateTime } }
function Get-SpecKey($p) { "$($p.id)/$($p.born)" }
function Get-TreeNow { $script:clock += 100; ConvertFrom-SpecMs $script:clock }
function Get-TreeSnapshot {
  if ($spec.failSnapshot) { throw 'WMI is unavailable' }
  $all = @($spec.snapshots)
  $i = [Math]::Min($script:round, $all.Count - 1)
  $script:round++
  $script:current = @($all[$i] | Where-Object { $_ -and -not ($script:dead.ContainsKey((Get-SpecKey $_)) -and -not $_.unkillable) })
  [pscustomobject]@{ Id = $PID; ParentId = 0; Born = (ConvertFrom-SpecMs 1) }
  foreach ($p in $script:current) { [pscustomobject]@{ Id = [int]$p.id; ParentId = [int]$p.parent; Born = (ConvertFrom-SpecMs $p.born) } }
}
function Open-TreeMember([int]$id, [DateTime]$born) {
  $p = $script:current | Where-Object { [int]$_.id -eq $id } | Select-Object -First 1
  if (-not $p -or $p.takenOver) { return 'gone' }
  if ($p.openDenied) { return 'denied' }
  $script:pinned[$id] = $p
  'pinned'
}
function Stop-TreeMember([int]$id) {
  $p = $script:pinned[$id]
  if ($p.killDenied) { return 'denied' }
  $script:killed.Add($id)
  $script:dead[(Get-SpecKey $p)] = $true
  'killed'
}
function Test-TreeMemberExited([int]$id) {
  $p = $script:pinned[$id]
  $script:dead.ContainsKey((Get-SpecKey $p)) -and -not $p.unkillable
}
function Wait-TreeMember([int]$id, [int]$ms) { }
`

async function run(
  scenario: Scenario,
): Promise<{ code: number; killed: number[]; stderr: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-kill-'))
  const file = path.join(dir, 'harness.ps1')
  const spec = JSON.stringify({ ...scenario, now: scenario.bornBefore + 10_000 })
  const script =
    `$spec = ConvertFrom-Json @'\n${spec}\n'@\n${MOCK_IO}${TREE_KILL_CORE}` +
    `$code = Invoke-TreeKill -Root ${String(scenario.root)} -BornAfter ${String(scenario.bornAfter)} ` +
    `-BornBefore ${String(scenario.bornBefore)} -AliveAt ${String(scenario.aliveAt)} -Seconds 2\n` +
    `[Console]::Out.WriteLine('RESULT ' + [int]@($code)[-1] + ' ' + (@($script:killed | Sort-Object -Unique) -join ','))\n`
  try {
    await fs.writeFile(file, script, 'utf8')
    const result = spawnSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 60_000 },
    )
    const match = /RESULT (\d+) ([\d,]*)/.exec(result.stdout)
    if (!match) throw new Error(`no result: ${result.stdout}\n${result.stderr}`)
    return {
      code: Number(match[1]),
      killed: (match[2] ?? '').split(',').filter(Boolean).map(Number),
      stderr: result.stderr,
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// The shell was spawned between T0 and T1 and created at BORN; the app still held its
// handle at ALIVE, 1 s before the kill started.
const T0 = 1_700_000_000_000
const T1 = T0 + 50
const BORN = T0 + 20
const ALIVE = T1 + 9_000
const ROOT = 100
const base = { root: ROOT, bornAfter: T0, bornBefore: T1, aliveAt: ALIVE }
const shell: Proc = { id: ROOT, parent: 1, born: BORN }
const unrelated: Proc = { id: 900, parent: 1, born: T0 - 60_000 }

describe.runIf(available)('the fallback tree kill', { timeout: 120_000 }, () => {
  it('kills the shell, its children and grandchildren, then reports success', async () => {
    const child = { id: 200, parent: ROOT, born: T0 + 1_000 }
    const grandchild = { id: 300, parent: 200, born: T0 + 2_000 }
    expect(
      await run({ ...base, snapshots: [[shell, child, grandchild, unrelated]] }),
    ).toMatchObject({ code: 0, killed: [100, 200, 300] })
  })

  it('also kills a grandchild started while the tree is being killed', async () => {
    const child = { id: 200, parent: ROOT, born: T0 + 1_000 }
    // Started by the child after the first snapshot (taken at T1 + 10.1 s).
    const late = { id: 300, parent: 200, born: T1 + 10_150 }
    expect(
      await run({
        ...base,
        snapshots: [
          [shell, child],
          [shell, child, late],
        ],
      }),
    ).toMatchObject({ code: 0, killed: [100, 200, 300] })
  })

  it('never adopts the child of a process that reused a dead member id', async () => {
    // Member 200 exits before it can be pinned; another process takes id 200, starts
    // 300 and exits, all before the next snapshot.
    const child = { id: 200, parent: ROOT, born: T0 + 1_000, takenOver: true }
    const stranger = { id: 300, parent: 200, born: T1 + 10_400 }
    const result = await run({
      ...base,
      snapshots: [
        [shell, child],
        [shell, stranger],
      ],
    })
    expect(result).toMatchObject({ code: 4, killed: [100] })
    expect(result.stderr).toContain(
      'process 300 was started by 200 after its id may have been reused',
    )
  })

  it('never kills a process that reused the shell id, or its children', async () => {
    const reuser = { id: ROOT, parent: 1, born: ALIVE + 500 }
    const itsChild = { id: 400, parent: ROOT, born: ALIVE + 600 }
    for (const aliveAt of [ALIVE, -1]) {
      expect(await run({ ...base, aliveAt, snapshots: [[reuser, itsChild]] })).toMatchObject({
        code: 4,
        killed: [],
      })
    }
    // Nothing of the tree is left: that is success, with the stranger untouched.
    expect(await run({ ...base, snapshots: [[reuser, unrelated]] })).toMatchObject({
      code: 0,
      killed: [],
    })
  })

  it('adopts the children of a shell that already exited only up to when its id was held', async () => {
    const early = { id: 400, parent: ROOT, born: T0 + 3_000 }
    const after = { id: 500, parent: ROOT, born: ALIVE + 500 }
    expect(await run({ ...base, snapshots: [[early]] })).toMatchObject({ code: 0, killed: [400] })
    expect(await run({ ...base, snapshots: [[early, after]] })).toMatchObject({
      code: 4,
      killed: [400],
    })
    // Without knowing when the id was last held, none of them is taken for the shell's.
    expect(await run({ ...base, aliveAt: -1, snapshots: [[early]] })).toMatchObject({
      code: 4,
      killed: [],
    })
    // A process that was there before the shell was created is not its child.
    const older = { id: 600, parent: ROOT, born: T0 - 5_000 }
    expect(await run({ ...base, aliveAt: -1, snapshots: [[older]] })).toMatchObject({
      code: 0,
      killed: [],
    })
  })

  it('leaves processes with an unreadable start time running and reports it', async () => {
    const unknown = { id: 200, parent: ROOT, born: null }
    const result = await run({ ...base, snapshots: [[shell, unknown]] })
    expect(result).toMatchObject({ code: 4, killed: [100] })
    expect(result.stderr).toContain('process 200, started by 100, has no readable start time')
    expect(
      await run({ ...base, snapshots: [[{ ...shell, born: null }, unrelated]] }),
    ).toMatchObject({ code: 4, killed: [] })
  })

  it('never kills the shell without knowing when it was created', async () => {
    const result = await run({ ...base, bornAfter: -1, bornBefore: -1, snapshots: [[shell]] })
    expect(result).toMatchObject({ code: 4, killed: [] })
    expect(result.stderr).toContain('process 100 is running but cannot be identified as the shell')
  })

  it('stops with a failure as soon as killing a member is denied', async () => {
    const child = { id: 200, parent: ROOT, born: T0 + 1_000, killDenied: true }
    const result = await run({ ...base, snapshots: [[shell, child]] })
    expect(result.code).toBe(3)
    expect(result.killed).not.toContain(200)
    expect(result.stderr).toContain('process 200 cannot be killed: access denied')
  })

  it('fails when a member cannot be opened, after killing the rest', async () => {
    const child = { id: 200, parent: ROOT, born: T0 + 1_000, openDenied: true }
    expect(await run({ ...base, snapshots: [[shell, child]] })).toMatchObject({
      code: 3,
      killed: [100],
    })
  })

  it('fails at the deadline while a member is still running', async () => {
    const stuck = { id: 200, parent: ROOT, born: T0 + 1_000, unkillable: true }
    expect(await run({ ...base, snapshots: [[shell, stuck]] })).toMatchObject({ code: 1 })
  })

  it('fails when the processes cannot be listed', async () => {
    const result = await run({ ...base, snapshots: [[shell]], failSnapshot: true })
    expect(result).toMatchObject({ code: 2, killed: [] })
    expect(result.stderr).toContain('WMI is unavailable')
  })

  it('has a reason for every failure exit code', () => {
    expect(Object.keys(TREE_KILL_EXIT).map(Number)).toEqual([1, 2, 3, 4])
  })
})
