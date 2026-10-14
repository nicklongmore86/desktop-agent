// A small line-based unified diff (Myers' O(ND) algorithm) for approval
// previews, so the app needs no diff dependency. Lines keep their terminators
// while diffing, so a missing final newline shows up the way git shows it.

type Op = { type: ' ' | '-' | '+'; line: string }

export interface UnifiedDiff {
  text: string
  added: number
  removed: number
}

/** Above this many differing lines, the middle is shown as a block replace. */
const MAX_EDIT_DISTANCE = 2000

function splitKeepingTerminators(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function myers(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = maxD + 1
  const v = new Int32Array(2 * maxD + 3)
  // trace[d] holds v[-d..d] after step d.
  const trace: Int32Array[] = []
  const at = (row: Int32Array, d: number, k: number): number => row[k + d] ?? 0

  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1))
        return backtrack(a, b, trace, d, at)
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  return null
}

function backtrack(
  a: readonly string[],
  b: readonly string[],
  trace: Int32Array[],
  dEnd: number,
  at: (row: Int32Array, d: number, k: number) => number,
): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = dEnd; d > 0; d--) {
    const prev = trace[d - 1] ?? new Int32Array(0)
    const k = x - y
    const down = k === -d || (k !== d && at(prev, d - 1, k - 1) < at(prev, d - 1, k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prev, d - 1, prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: ' ', line: a[--x] ?? '' })
      y--
    }
    if (x === prevX) ops.push({ type: '+', line: b[--y] ?? '' })
    else ops.push({ type: '-', line: a[--x] ?? '' })
  }
  while (x > 0 && y > 0) {
    ops.push({ type: ' ', line: a[--x] ?? '' })
    y--
  }
  return ops.reverse()
}

function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  // Trim the common head and tail first: most edits are local.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const middle = myers(midA, midB) ?? [
    ...midA.map((line): Op => ({ type: '-', line })),
    ...midB.map((line): Op => ({ type: '+', line })),
  ]
  return [
    ...a.slice(0, start).map((line): Op => ({ type: ' ', line })),
    ...middle,
    ...a.slice(endA).map((line): Op => ({ type: ' ', line })),
  ]
}

function render(op: Op): string {
  const body = op.line.replace(/\r?\n$/, '')
  const noNewline = op.line.endsWith('\n') ? '' : '\n\\ No newline at end of file'
  return `${op.type}${body}${noNewline}`
}

/**
 * A unified diff of `oldText` → `newText`, with `context` lines around each
 * change. `oldText` null means the file is new (`--- /dev/null`).
 */
export function unifiedDiff(
  oldText: string | null,
  newText: string,
  label: string,
  context = 3,
): UnifiedDiff {
  const ops = diffOps(splitKeepingTerminators(oldText ?? ''), splitKeepingTerminators(newText))
  const header = `--- ${oldText === null ? '/dev/null' : `a/${label}`}\n+++ b/${label}\n`
  const added = ops.filter((op) => op.type === '+').length
  const removed = ops.filter((op) => op.type === '-').length
  if (added === 0 && removed === 0) return { text: '', added, removed }

  const changes = ops.flatMap((op, i) => (op.type === ' ' ? [] : [i]))
  const hunks: string[] = []
  let i = 0
  while (i < changes.length) {
    let j = i
    while (j + 1 < changes.length && (changes[j + 1] ?? 0) - (changes[j] ?? 0) <= 2 * context) j++
    const from = Math.max(0, (changes[i] ?? 0) - context)
    const to = Math.min(ops.length, (changes[j] ?? 0) + context + 1)

    let oldLine = 1
    let newLine = 1
    for (const op of ops.slice(0, from)) {
      if (op.type !== '+') oldLine++
      if (op.type !== '-') newLine++
    }
    const slice = ops.slice(from, to)
    const oldCount = slice.filter((op) => op.type !== '+').length
    const newCount = slice.filter((op) => op.type !== '-').length
    // Unified diff numbers an empty range by the line before it.
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine
    const newStart = newCount === 0 ? newLine - 1 : newLine
    hunks.push(
      `@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@\n` +
        slice.map(render).join('\n'),
    )
    i = j + 1
  }
  return { text: `${header}${hunks.join('\n')}\n`, added, removed }
}
