import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Workspace panel's Git tab in real Electron (fake main): changed files, a diff,
 * the commit list, a repository with no commits and git not installed, in light and
 * dark at desktop and phone width. Screenshots (git-*) go to e2e-artifacts/ui/.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')

interface E2eWindow {
  e2e: {
    setGit: (state: 'missing' | 'empty' | 'notRepo') => void
    pushGitChanged: (stopped?: boolean) => void
    gitCalls: () => {
      status: unknown[]
      diff: { path: string; area: string }[]
      log: { skip: number }[]
      watch: unknown[][]
      install: number
    }
  }
}

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

const e2e = (page: Page) => ({
  setGit: (state: 'missing' | 'empty' | 'notRepo') =>
    page.evaluate((s) => {
      ;(window as unknown as E2eWindow).e2e.setGit(s)
    }, state),
  push: (stopped = false) =>
    page.evaluate((s) => {
      ;(window as unknown as E2eWindow).e2e.pushGitChanged(s)
    }, stopped),
  calls: () => page.evaluate(() => (window as unknown as E2eWindow).e2e.gitCalls()),
})

for (const viewport of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`git panel at ${String(viewport)}px, ${scheme}`, async () => {
      mkdirSync(OUT, { recursive: true })
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
          await page.screenshot({ path: join(OUT, `${name}-${scheme}-${String(viewport)}.png`) })
        }
        const noSidewaysScroll = (): Promise<boolean> =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        const fake = e2e(page)

        if (viewport <= 540) await page.getByRole('button', { name: 'Workspace panel' }).click()
        await page.getByRole('tab', { name: 'Git' }).click()
        const panel = page.getByRole('tabpanel', { name: 'Git' })

        // Changes: branch, ahead/behind, grouped files with status letters.
        await expect(panel.getByText('feature/git-panel', { exact: true })).toBeVisible()
        await expect(panel.getByText('2 ahead, 1 behind origin/feature/git-panel')).toBeAttached()
        await expect(
          panel.getByRole('button', { name: /^GitTab\.tsx.*Added, staged/ }),
        ).toBeVisible()
        await expect(
          panel.getByRole('button', { name: 'Insert reference to .env into chat' }),
        ).toHaveAttribute('aria-disabled', 'true')
        expect((await fake.calls()).watch.at(-1)).toEqual([
          { rootId: 'r00000000000000a1', rel: '' },
        ])
        expect(await noSidewaysScroll()).toBe(true)
        await shot('git-changes')

        // A file's diff, as plain text.
        await panel.getByRole('button', { name: /^App\.tsx/ }).click()
        const diff = panel.getByRole('region', { name: 'Diff of src/App.tsx' })
        await expect(
          diff.getByText('+              git: <GitTab grants={grants} />,'),
        ).toBeVisible()
        expect((await fake.calls()).diff.at(-1)).toMatchObject({
          path: 'src/App.tsx',
          area: 'unstaged',
        })
        expect(await noSidewaysScroll()).toBe(true)
        await shot('git-diff')
        await diff.getByRole('button', { name: '← Changes' }).click()

        // Commits.
        await panel.getByRole('tab', { name: 'Commits' }).click()
        await expect(panel.getByText('Add the Git panel (read-only)')).toBeVisible()
        await expect(panel.getByRole('button', { name: 'Load more commits' })).toBeVisible()
        await shot('git-commits')

        // A repository with no commits and a clean tree, refreshed by main's push.
        await fake.setGit('empty')
        await fake.push()
        await expect(panel.getByText('No commits yet.')).toBeVisible()
        await panel.getByRole('tab', { name: 'Changes' }).click()
        await expect(panel.getByText('main (no commits yet)', { exact: true })).toBeVisible()
        await expect(panel.getByText(/working tree is clean/)).toBeVisible()
        await shot('git-empty')

        // Git not installed: the install link goes through main.
        await fake.setGit('missing')
        await fake.push(true)
        await expect(panel.getByText('Git is not installed')).toBeVisible()
        await panel.getByRole('button', { name: 'Install Git for Windows' }).click()
        await expect.poll(async () => (await fake.calls()).install).toBe(1)
        expect(await noSidewaysScroll()).toBe(true)
        await shot('git-nogit')
      } finally {
        await app.close()
      }
    })
  }
}
