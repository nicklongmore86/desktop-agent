import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiContext } from './api'
import themeInit from '../public/theme-init.js?raw'
import { applyTheme, useTheme } from './theme'
import { fakeApi } from './test/fake-api'

const wrapper =
  (api: ReturnType<typeof fakeApi>['api']) =>
  ({ children }: { children: ReactNode }) => <ApiContext value={api}>{children}</ApiContext>
const html = document.documentElement

beforeEach(() => {
  applyTheme('system')
})

describe('theme before first paint', () => {
  // The blocking script in index.html; it only reads the cache theme.ts writes.
  const runInit = (): void => {
    window.eval(themeInit)
  }

  it('applies a cached light or dark choice and leaves system alone', () => {
    for (const theme of ['dark', 'light'] as const) {
      applyTheme(theme)
      delete html.dataset['theme']
      runInit()
      expect(html.dataset['theme']).toBe(theme)
    }
    applyTheme('system')
    runInit()
    expect(html.dataset['theme']).toBeUndefined()
  })

  it('ignores a corrupt cache and unavailable storage', () => {
    localStorage.setItem('desktop-agent:theme', 'sepia')
    runInit()
    expect(html.dataset['theme']).toBeUndefined()
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(runInit).not.toThrow()
    get.mockRestore()
  })
})

describe('theme', () => {
  it('applies light and dark as data-theme and system by clearing it', () => {
    applyTheme('dark')
    expect(html.dataset['theme']).toBe('dark')
    applyTheme('light')
    expect(html.dataset['theme']).toBe('light')
    applyTheme('system')
    expect(html.dataset['theme']).toBeUndefined()
  })

  it('loads the saved theme from main and applies it', async () => {
    const { api } = fakeApi({ theme: 'dark' })
    const { result } = renderHook(() => useTheme(), { wrapper: wrapper(api) })
    await waitFor(() => {
      expect(result.current.theme).toBe('dark')
    })
    expect(html.dataset['theme']).toBe('dark')
    expect(localStorage.getItem('desktop-agent:theme')).toBe('dark')
  })

  it('saves a choice through main and applies it at once', async () => {
    const { api } = fakeApi()
    const { result } = renderHook(() => useTheme(), { wrapper: wrapper(api) })
    await act(() => result.current.setTheme('light'))
    expect(api.theme.set).toHaveBeenCalledWith('light')
    expect(result.current.theme).toBe('light')
    expect(html.dataset['theme']).toBe('light')
  })

  it('goes back to the previous theme when saving fails', async () => {
    const { api } = fakeApi({ theme: 'dark' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useTheme(), { wrapper: wrapper(api) })
    await waitFor(() => {
      expect(result.current.theme).toBe('dark')
    })
    api.theme.set.mockRejectedValueOnce(new Error('disk full'))
    await act(() => result.current.setTheme('light'))
    expect(result.current.theme).toBe('dark')
    expect(html.dataset['theme']).toBe('dark')
    error.mockRestore()
  })

  it('shares one choice between components', async () => {
    const { api } = fakeApi()
    function Picker(): React.JSX.Element {
      const { theme, setTheme } = useTheme()
      return (
        <button
          onClick={() => {
            void setTheme('dark')
          }}
        >
          now {theme}
        </button>
      )
    }
    render(
      <ApiContext value={api}>
        <Picker />
        <Picker />
      </ApiContext>,
    )
    await userEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'now dark',
      'now dark',
    ])
  })
})
