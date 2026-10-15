import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt } from '../src/shared/ipc'

/**
 * Renders adversarial approval prompts in real Electron/Chromium (the built
 * renderer bundle, a fake preload API) at a phone-narrow and a desktop width,
 * and checks the dialog in the DOM: nothing clipped silently, hidden and bidi
 * characters revealed, no markup rendered, and Approve/Deny on screen and
 * clickable. Screenshots go to e2e-artifacts/ for CI.
 */

const ROOT = join(__dirname, '..')
const SHOTS = join(ROOT, 'e2e-artifacts')
const PROJECT = 'C:\\Users\\me\\Projects'

interface Case {
  name: string
  prompt: Omit<ApprovalPrompt, 'id' | 'runId' | 'toolUseId'>
  /** Strings the dialog's rendered text must contain (after reveal). */
  shows: string[]
  /** The prompt has hidden characters, so the warning must be shown. */
  warns: boolean
  /** The prompt has right-to-left letters, so the stored-order notice must be shown. */
  rtl?: boolean
}

const longSegment = 'a'.repeat(300)
const longCommand = `powershell.exe-NoProfile-Command${'Get-ChildItem|'.repeat(150)}END_OF_COMMAND`
const shellDetail = (cwd: string, command: string): string =>
  `cwd: ${cwd}\nshell: powershell.exe\n\n${command}`

// Natural right-to-left letters, written as escapes so this file holds none.
const ALEF = '\u05D0'
const SHALOM = '\u05E9\u05DC\u05D5\u05DD'
const FIX = '\u05EA\u05D9\u05E7\u05D5\u05DF'
const DANA = '\u05D3\u05E0\u05D4'
const MILAF = '\u0645\u0644\u0641'

const CASES: Case[] = [
  {
    name: 'long-path',
    prompt: {
      tool: 'delete_path',
      kind: 'delete',
      summary: `Move ${PROJECT}\\${longSegment}\\END_OF_PATH.txt to the Recycle Bin`,
      detail: `${PROJECT}\\${longSegment}\\END_OF_PATH.txt`,
    },
    shows: [`${longSegment}\\END_OF_PATH.txt`],
    warns: false,
  },
  {
    name: 'long-command',
    prompt: {
      tool: 'run_shell',
      kind: 'shell',
      summary: `Run a command in ${PROJECT}\\${longSegment}`,
      detail: shellDetail(`${PROJECT}\\${longSegment}`, longCommand),
    },
    shows: ['END_OF_COMMAND', longSegment],
    warns: false,
  },
  {
    name: 'bidi',
    prompt: {
      tool: 'move_file',
      kind: 'move',
      summary: `Rename invoice\u202Etxt.exe to report\u2067fdp.ps1\u2069`,
      detail: `${PROJECT}\\invoice\u202Etxt.exe\n→ ${PROJECT}\\a\u202Bb\u202Ac\u200Fd\u200E\u061Ce\u2066f\u2068g\u202Cs`,
    },
    shows: ['invoice⟨U+202E⟩txt.exe', 'report⟨U+2067⟩fdp.ps1⟨U+2069⟩'],
    warns: true,
  },
  {
    name: 'zero-width',
    prompt: {
      tool: 'run_shell',
      kind: 'shell',
      summary: `Run a command in ${PROJECT}`,
      detail: shellDetail(
        PROJECT,
        'Remove-Item\u200B -Recurse\u200C C:\\Win\u200Ddows\u2060\uFEFF',
      ),
    },
    shows: ['Remove-Item⟨U+200B⟩', 'Win⟨U+200D⟩dows⟨U+2060⟩⟨U+FEFF⟩'],
    warns: true,
  },
  {
    name: 'homoglyph',
    prompt: {
      tool: 'delete_path',
      kind: 'delete',
      // Cyrillic а (U+0430) and е (U+0435), a division slash (U+2215) and a fullwidth dot.
      summary: `Move ${PROJECT}\\p\u0430yp\u0430l\u2215..\u2215s\u0435cr\u0435ts\uFF0Etxt to the Recycle Bin`,
      detail: `${PROJECT}\\p\u0430yp\u0430l\u2215..\u2215s\u0435cr\u0435ts\uFF0Etxt`,
    },
    shows: ['⟨U+0430⟩', '⟨U+2215⟩', '⟨U+0435⟩', '⟨U+FF0E⟩'],
    warns: true,
  },
  {
    // Cyrillic рау on its own in the command box: tokenised in the prompt's Latin context.
    name: 'lookalike-command',
    prompt: {
      tool: 'run_shell',
      kind: 'shell',
      summary: `Run a command in ${PROJECT}`,
      detail: shellDetail(PROJECT, '.\\\u0440\u0430\u0443'),
    },
    shows: ['.\\⟨U+0440⟩⟨U+0430⟩⟨U+0443⟩'],
    warns: true,
  },
  {
    name: 'ansi',
    prompt: {
      tool: 'run_shell',
      kind: 'shell',
      summary: `Run a command in ${PROJECT}`,
      detail: shellDetail(
        PROJECT,
        'echo \u001b[8mhidden\u001b[0m \u001b[31mred\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 \u001b[2K\u001b[1Aclear',
      ),
    },
    shows: ['⟨ESC[8m⟩hidden', '⟨ESC]8;;https://evil.example{U+0007}⟩link', '⟨ESC[2K⟩⟨ESC[1A⟩clear'],
    warns: true,
  },
  {
    name: 'newlines',
    prompt: {
      tool: 'delete_path',
      kind: 'delete',
      summary: `Move ${PROJECT}\\notes.txt\nC:\\Windows\\System32 to the Recycle Bin`,
      detail: `${PROJECT}\\notes.txt\nC:\\Windows\\System32\rC:\\Windows\r\n`,
    },
    shows: ['notes.txt⏎', 'System32⟨CR⟩', 'C:\\Windows⟨CRLF⟩'],
    warns: true,
  },
  {
    name: 'markup',
    prompt: {
      tool: 'write_file',
      kind: 'write',
      summary: `Write **bold** <img src=x onerror="window.pwned=1"> [link](https://evil.example) <b>b</b>`,
      detail: [
        `--- ${PROJECT}\\x.md`,
        `+++ ${PROJECT}\\x.md`,
        '@@ -0,0 +1,3 @@',
        '+<script>window.pwned=1</script>',
        '+# Heading <a href="https://evil.example">click</a>',
        '+<iframe src="https://evil.example"></iframe>',
      ].join('\n'),
    },
    shows: ['**bold** <img src=x onerror="window.pwned=1">', '<script>window.pwned=1</script>'],
    warns: false,
  },
  {
    // Without an override, the bidi algorithm shows this as C:\\safe\\..\\א\\evil.exe or similar.
    name: 'rtl-path',
    prompt: {
      tool: 'delete_path',
      kind: 'delete',
      summary: `Move C:\\safe\\${ALEF}\\..\\evil.exe to the Recycle Bin`,
      detail: `C:\\safe\\${ALEF}\\..\\evil.exe`,
    },
    shows: [`C:\\safe\\${ALEF}\\..\\evil.exe`],
    warns: false,
    rtl: true,
  },
  {
    name: 'rtl-flags',
    prompt: {
      tool: 'run_shell',
      kind: 'shell',
      summary: `Run a command in ${PROJECT}\\${SHALOM}`,
      detail: shellDetail(
        `${PROJECT}\\${SHALOM} 2`,
        `Copy-Item -Force .\\${SHALOM}\\..\\a.ps1 -Destination C:\\Windows\\System32\\ ${MILAF}.txt:1 -Recurse`,
      ),
    },
    shows: [`.\\${SHALOM}\\..\\a.ps1 -Destination`, `${MILAF}.txt:1 -Recurse`],
    warns: false,
    rtl: true,
  },
  {
    name: 'rtl-move',
    prompt: {
      tool: 'move_file',
      kind: 'move',
      summary: `Move ${MILAF}.1.txt to ${MILAF} 2\\..\\x.exe`,
      detail: `${PROJECT}\\${MILAF}.1.txt\n→ ${PROJECT}\\${MILAF} 2\\..\\x.exe`,
    },
    shows: [`${MILAF}.1.txt`, `${MILAF} 2\\..\\x.exe`],
    warns: false,
    rtl: true,
  },
  {
    name: 'rtl-mixed-command',
    prompt: {
      tool: 'run_shell',
      kind: 'shell',
      summary: `Run a command in ${PROJECT}`,
      detail: shellDetail(
        PROJECT,
        `git commit -m "${FIX} bug 12 ${ALEF}-v2.0" --author="${DANA} <d@x.io>"`,
      ),
    },
    shows: [`"${FIX} bug 12 ${ALEF}-v2.0" --author="${DANA} <d@x.io>"`],
    warns: false,
    rtl: true,
  },
  {
    name: 'everything',
    prompt: {
      tool: `run_shell${'_'.repeat(80)}\u202E`,
      kind: 'shell',
      summary: `Run a command in ${PROJECT}\\${longSegment}\u200B\n`.repeat(4),
      detail: shellDetail(
        `${PROJECT}\\${longSegment}\u202E`,
        `${longCommand}\n`.repeat(6) + 'FINAL_LINE',
      ),
    },
    shows: ['FINAL_LINE', 'END_OF_COMMAND'],
    warns: true,
  },
]

// Raw bidi controls, zero-width and C0/C1 controls (except \t and \n) must never reach the screen.
const RAW_HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF\u061C\u0000-\u0008\u000B-\u001F\u007F-\u009F]/

async function launch(
  width: number,
  height: number,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // Linux CI runners (and root) cannot use Chromium's setuid/userns sandbox; the
    // renderer's own `sandbox: true` web preference still applies.
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: ROOT,
    env: { ...process.env, E2E_WIDTH: String(width), E2E_HEIGHT: String(height) },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByRole('heading', { name: 'Desktop Agent' })).toBeVisible()
  // Wait for the chat to subscribe to approvals before pushing any.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as E2eWindow).e2e.listenerCount()))
    .toBeGreaterThan(1)
  return { app, page }
}

interface E2eWindow {
  e2e: {
    pushApproval: (prompt: ApprovalPrompt) => void
    responses: () => { id: string; approved: boolean }[]
    listenerCount: () => number
  }
}

/** Layout problems inside the dialog, as human-readable strings (empty when fine). */
function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')
    if (!dialog) return ['no dialog']
    const describe = (el: Element): string =>
      `${el.tagName.toLowerCase()}${el.className ? `.${el.className.split(' ').join('.')}` : ''}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label') ?? ''}]` : ''}`
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (document.documentElement.scrollWidth > vw + 1)
      problems.push(
        `page scrolls sideways (${String(document.documentElement.scrollWidth)} > ${String(vw)})`,
      )
    const box = dialog.getBoundingClientRect()
    if (box.left < -1 || box.right > vw + 1 || box.top < -1 || box.bottom > vh + 1)
      problems.push(`dialog outside the viewport: ${JSON.stringify(box)}`)
    const scrollable = (overflow: string): boolean => overflow === 'auto' || overflow === 'scroll'
    /** The nearest keyboard-focusable scroll box for an axis, below the dialog itself. */
    const scrollBox = (el: HTMLElement, axis: 'overflowX' | 'overflowY'): HTMLElement | null => {
      for (let at: HTMLElement | null = el; at && at !== dialog; at = at.parentElement) {
        if (scrollable(getComputedStyle(at)[axis]) && at.tabIndex === 0) return at
      }
      return null
    }
    // The dialog itself never scrolls: that could move the buttons or the title away.
    if (dialog.scrollWidth > dialog.clientWidth + 1) problems.push('the dialog overflows sideways')
    if (dialog.scrollHeight > dialog.clientHeight + 1)
      problems.push('the dialog overflows downwards')
    for (const el of dialog.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(el)
      if (style.textOverflow === 'ellipsis')
        problems.push(`${describe(el)} truncates with an ellipsis`)
      // Inline elements report no client box; their block ancestors are checked instead.
      if (style.display === 'inline' || el.clientWidth === 0) continue
      // Overflow is fine only where a focusable scroll box (the element or an ancestor) shows it.
      if (el.scrollWidth > el.clientWidth + 1 && !scrollBox(el, 'overflowX'))
        problems.push(`${describe(el)} overflows sideways with no focusable scroll box`)
      if (el.scrollHeight > el.clientHeight + 1 && !scrollBox(el, 'overflowY'))
        problems.push(`${describe(el)} overflows downwards with no focusable scroll box`)
    }
    return problems
  })
}

/** Rendered text of the dialog with raw characters intact (innerText applies no transforms we rely on). */
const dialogText = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[role="alertdialog"]')?.innerText ?? '')

/**
 * Asserts that `text` appears somewhere in the dialog and that every character
 * of it is reachable: either inside the viewport or inside a scroll box that
 * can be scrolled to it. Scrolls each match into view and checks it lands
 * within the dialog's visible area.
 */
async function expectReachable(page: Page, text: string): Promise<void> {
  const result = await page.evaluate((needle) => {
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')
    if (!dialog) return 'no dialog'
    // Flatten text nodes so a needle can span the segments of a revealed line.
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let all = ''
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node as Text)
      all += (node as Text).data
    }
    const start = all.indexOf(needle)
    if (start < 0) return `not in the dialog: ${needle.slice(0, 80)}`
    const end = start + needle.length
    // Check the first and last character of the match.
    for (const offset of [start, end - 1]) {
      let rest = offset
      const node = nodes.find((candidate) => {
        if (rest < candidate.data.length) return true
        rest -= candidate.data.length
        return false
      })
      if (!node) return 'offset outside text'
      const range = document.createRange()
      range.setStart(node, rest)
      range.setEnd(node, rest + 1)
      node.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      // scrollIntoView on the parent may not reach a character deep in a long line.
      let rect = range.getBoundingClientRect()
      for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
        const box = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (style.overflowX === 'auto' || style.overflowX === 'scroll')
          el.scrollLeft += rect.left - box.left - box.width / 2
        if (style.overflowY === 'auto' || style.overflowY === 'scroll')
          el.scrollTop += rect.top - box.top - box.height / 2
        rect = range.getBoundingClientRect()
      }
      if (rect.width === 0 && rect.height === 0) return `character ${String(offset)} has no box`
      // The character must be visible on screen and not hidden under another element.
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      if (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight)
        return `character ${String(offset)} of "${needle.slice(0, 40)}" is off screen at ${String(x)},${String(y)}`
      const hit = document.elementFromPoint(x, y)
      if (
        !hit ||
        !(hit === node.parentElement || node.parentElement?.contains(hit) || hit.contains(node))
      )
        return `character ${String(offset)} of "${needle.slice(0, 40)}" is covered by ${hit?.tagName ?? 'nothing'}`
    }
    return null
  }, text)
  expect(result, text.slice(0, 80)).toBeNull()
}

/** Characters of each untrusted line are laid out left to right in source order (no bidi reordering). */
function bidiProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    const dialog = document.querySelector('[role="alertdialog"]')
    for (const line of dialog?.querySelectorAll<HTMLElement>('.untrusted-line') ?? []) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let previous: DOMRect | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        for (let i = 0; i < text.data.length; i += 1) {
          if (/\s/.test(text.data[i] ?? '')) continue
          const range = document.createRange()
          range.setStart(text, i)
          range.setEnd(text, i + 1)
          const rect = range.getBoundingClientRect()
          if (rect.width === 0) continue
          // Same visual line (wrapping moves down and back to the left, which is fine).
          if (
            previous &&
            Math.abs(rect.top - previous.top) < 2 &&
            rect.left < previous.left - 0.5
          ) {
            problems.push(`"${text.data.slice(Math.max(0, i - 10), i + 10)}" renders out of order`)
            break
          }
          previous = rect
        }
      }
    }
    return problems
  })
}

async function expectButtonsUsable(page: Page): Promise<void> {
  for (const name of ['Deny', 'Approve']) {
    const button = page.getByRole('button', { name, exact: true })
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
    const covered = await button.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      if (
        rect.left < 0 ||
        rect.top < 0 ||
        rect.right > window.innerWidth ||
        rect.bottom > window.innerHeight
      )
        return `off screen: ${JSON.stringify(rect)}`
      if (rect.width < 24 || rect.height < 24) return `too small: ${JSON.stringify(rect)}`
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.1, 0.2],
        [0.9, 0.8],
      ] as const) {
        const hit = document.elementFromPoint(
          rect.left + rect.width * fx,
          rect.top + rect.height * fy,
        )
        if (hit !== el && !el.contains(hit))
          return `covered by ${hit?.outerHTML.slice(0, 80) ?? 'nothing'}`
      }
      return null
    })
    expect(covered, name).toBeNull()
  }
}

const WIDTHS = [
  { width: 360, height: 640 },
  { width: 1280, height: 800 },
]

for (const { width, height } of WIDTHS) {
  test.describe(`approval dialog at ${String(width)}px`, () => {
    let app: ElectronApplication | undefined
    let page: Page

    test.beforeAll(async () => {
      mkdirSync(SHOTS, { recursive: true })
      ;({ app, page } = await launch(width, height))
      // A real window of exactly that width: the OS clamps windows to the screen, so CI
      // raises the Windows runner's 1024x768 display first.
      expect(await page.evaluate(() => window.innerWidth)).toBe(width)
    })

    test.afterAll(async () => {
      await app?.close()
    })

    CASES.forEach((testCase, index) => {
      test(testCase.name, async () => {
        const id = `${testCase.name}-${String(width)}`
        expect(await page.evaluate(() => window.innerWidth)).toBe(width)
        const prompt: ApprovalPrompt = { id, runId: 'run-1', toolUseId: null, ...testCase.prompt }
        await page.evaluate((p) => {
          ;(window as unknown as E2eWindow).e2e.pushApproval(p)
        }, prompt)
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toBeVisible()
        // Deny has the initial focus.
        await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()

        await page.screenshot({ path: join(SHOTS, `approval-${id}.png`) })

        // Buttons first, before any scrolling: they must be usable as the dialog opens.
        await expectButtonsUsable(page)
        expect(await layoutProblems(page)).toEqual([])

        const text = await dialogText(page)
        expect(text).not.toMatch(RAW_HIDDEN)
        for (const shown of testCase.shows) await expectReachable(page, shown)
        expect(await bidiProblems(page)).toEqual([])
        await expect(
          dialog.getByText('this request contains hidden, control or look-alike'),
        ).toHaveCount(testCase.warns ? 1 : 0)
        await expect(dialog.getByText('contains right-to-left characters')).toHaveCount(
          testCase.rtl ? 1 : 0,
        )

        // Nothing in the untrusted text is rendered as markup.
        expect(
          await dialog
            .locator('img, a, script, iframe, strong:not(.approval-warning strong), b, h1')
            .count(),
        ).toBe(0)
        expect(
          await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
        ).toBeUndefined()

        // The buttons still work after scrolling the content around.
        await expectButtonsUsable(page)
        await page.screenshot({ path: join(SHOTS, `approval-${id}-scrolled.png`) })
        const approve = index % 2 === 0
        await page.getByRole('button', { name: approve ? 'Approve' : 'Deny', exact: true }).click()
        await expect(dialog).toBeHidden()
        const responses = await page.evaluate(() =>
          (window as unknown as E2eWindow).e2e.responses(),
        )
        expect(responses.at(-1)).toEqual({ id, approved: approve })
      })
    })
  })
}
