import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatEvent } from '../src/shared/ipc'

/**
 * Links and file names in a chat reply, in real Electron: the destination shows on hover and
 * on keyboard focus, a link whose text names another site asks first, and files and folders the
 * (fake) main process accepts are buttons that open or only show them. SHOT_DIR picks where the
 * review screenshots go; without it none are written, so CI only checks the behaviour.
 */

const OUT = process.env['SHOT_DIR']
const ROOT = 'C:\\Users\\me\\Projects'

interface E2eWindow {
  e2e: {
    pushChat: (event: ChatEvent) => void
    filesCalls: () => { open: string[] }
  }
}

const REPLY = [
  'I wrote the summary to `C:\\Users\\me\\Projects\\notes.md` and the folder is `C:\\Users\\me\\Projects\\src`.',
  '',
  'The installer is `C:\\Users\\me\\Projects\\setup.exe` (not opened from here), and `C:\\Windows\\notes.md` is outside your folders.',
  '',
  '- Read the [docs site](https://example.com/docs) first',
  '- Or the [https://example.com/login](https://evil.test/steal) page',
  '- Or [this one](https://exаmple.com/a%E2%80%AEb)',
].join('\n')

const settle = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            done()
          })
        })
      }),
  )

for (const viewport of [1280, 360]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`reply links at ${String(viewport)}px, ${scheme}`, async () => {
      if (OUT) mkdirSync(OUT, { recursive: true })
      const app = await electron.launch({
        args: [
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
          join(__dirname, 'harness/main.cjs'),
        ],
        cwd: join(__dirname, '..'),
        env: { ...process.env, E2E_WIDTH: String(viewport), E2E_HEIGHT: '800' },
      })
      try {
        const page = await app.firstWindow()
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
        const shot = async (name: string): Promise<void> => {
          await settle(page)
          if (OUT)
            await page.screenshot({
              path: join(OUT, `${name}-${String(viewport)}-${scheme}.png`),
            })
        }
        const push = (event: ChatEvent): Promise<void> =>
          page.evaluate((e) => {
            ;(window as unknown as E2eWindow).e2e.pushChat(e)
          }, event)
        await push({ type: 'run_started', runId: 'r', text: 'Summarise the project' })
        await push({ type: 'text_delta', runId: 'r', turn: 1, text: REPLY })
        await push({ type: 'run_finished', runId: 'r', stopReason: 'end_turn' })

        // Only what the fake main accepts becomes a button.
        const notes = page.getByRole('button', { name: `${ROOT}\\notes.md` })
        await expect(notes).toBeVisible()
        await expect(page.getByRole('button', { name: `${ROOT}\\src` })).toBeVisible()
        await expect(page.getByRole('button', { name: `${ROOT}\\setup.exe` })).toBeVisible()
        await expect(page.getByRole('button', { name: 'C:\\Windows\\notes.md' })).toHaveCount(0)
        await shot('reply')

        // Hover shows what a click does, and the full path.
        await notes.hover()
        const hint = page.getByRole('tooltip').filter({ hasText: `${ROOT}\\notes.md` })
        await expect(hint).toBeVisible()
        await expect(hint).toContainText('Open')
        await shot('hover-file')

        // The program is only shown in Explorer, and the hint says so; it is on screen at
        // phone width too.
        await page.getByRole('button', { name: `${ROOT}\\setup.exe` }).hover()
        const exeHint = page.getByRole('tooltip').filter({ hasText: 'not opened from a reply' })
        await expect(exeHint).toBeVisible()
        await expect(exeHint).toContainText('Show in Explorer')
        await shot('hover-program')

        // Keyboard focus shows the real destination of a web link.
        const docs = page.getByRole('link', { name: 'docs site' })
        await docs.focus()
        const docsHint = page.getByRole('tooltip').filter({ hasText: 'https://example.com/docs' })
        await expect(docsHint).toBeVisible()
        await shot('focus-link')

        // The look-alike and direction characters of a link target are visible tokens.
        const lookalike = page.getByRole('link', { name: 'this one' })
        await lookalike.hover()
        const lookHint = page.getByRole('tooltip').filter({ hasText: 'xn--exmple-4nf.com' })
        await expect(lookHint).toContainText('⟨U+0430⟩')
        await expect(lookHint).toContainText('⟨U+202E⟩')
        await shot('hover-lookalike')

        // A link whose text names another site asks first; nothing opens until confirmed.
        await page.getByRole('link', { name: 'https://example.com/login' }).click()
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.getByLabel('Real destination')).toHaveText('https://evil.test/steal')
        await shot('confirm-link')
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()

        // Clicking a file asks main (once); a program is shown, not opened.
        await notes.click()
        await expect(page.getByRole('status')).toContainText('Opened notes.md')
        await page.getByRole('button', { name: `${ROOT}\\setup.exe` }).click()
        await expect(page.getByRole('status')).toContainText('Shown in Explorer, not opened')
        await shot('click-program')
        const open = await page.evaluate(
          () => (window as unknown as E2eWindow).e2e.filesCalls().open,
        )
        expect(open).toEqual([`${ROOT}\\notes.md`, `${ROOT}\\setup.exe`])
      } finally {
        await app.close()
      }
    })
  }
}
