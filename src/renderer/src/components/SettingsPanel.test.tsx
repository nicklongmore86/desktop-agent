import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiKeyStatus, GrantsState, ModelSettings, ProviderStatus } from '../../../shared/ipc'
import { ApiContext } from '../api'
import { fakeApi } from '../test/fake-api'
import { SettingsPanel } from './SettingsPanel'

function Harness(props: { key0: ApiKeyStatus; grants0: GrantsState; model0: ModelSettings }) {
  const [keyStatus, setKeyStatus] = useState(props.key0)
  const [grants, setGrants] = useState(props.grants0)
  const [model, setModel] = useState(props.model0)
  return (
    <SettingsPanel
      keyStatus={keyStatus}
      onKeyStatus={setKeyStatus}
      grants={grants}
      onGrants={setGrants}
      model={model}
      onModel={setModel}
      audit={{ healthy: true, path: 'C:\\Users\\me\\AppData\\Roaming\\desktop-agent\\audit.jsonl' }}
    />
  )
}

async function renderSettings(key0: ApiKeyStatus, roots: string[] = []) {
  const fake = fakeApi({ key: key0, grants: { roots, loadError: null } })
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <Harness
        key0={key0}
        grants0={{ roots, loadError: null }}
        model0={await fake.api.model.get()}
      />
    </ApiContext>,
  )
  return { ...fake, user }
}

describe('SettingsPanel', () => {
  it('saves a key through a masked input and only ever shows "Key saved"', async () => {
    const { api, user } = await renderSettings({ saved: false, error: null })
    expect(screen.getByText('No key saved.')).toBeTruthy()
    const input = screen.getByLabelText('API key')
    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    await user.type(input, 'sk-ant-secret-value')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(api.apiKey.set).toHaveBeenCalledWith('sk-ant-secret-value')
    expect(screen.getByText('Key saved.')).toBeTruthy()
    expect(screen.queryByLabelText('API key')).toBeNull()
    expect(document.body.innerHTML).not.toContain('sk-ant-secret-value')
  })

  it('replaces and clears a saved key', async () => {
    const { api, user } = await renderSettings({ saved: true, error: null })
    await user.click(screen.getByRole('button', { name: 'Replace key' }))
    const input = screen.getByLabelText('API key')
    expect(input).toHaveProperty('value', '')
    await user.type(input, 'sk-new')
    await user.click(screen.getByRole('button', { name: 'Replace key' }))
    expect(api.apiKey.set).toHaveBeenCalledWith('sk-new')
    await user.click(screen.getByRole('button', { name: 'Clear key' }))
    expect(api.apiKey.clear).toHaveBeenCalledOnce()
    expect(screen.getByText('No key saved.')).toBeTruthy()
  })

  it('shows key store errors', async () => {
    const { api, user } = await renderSettings({ saved: false, error: null })
    api.apiKey.set.mockResolvedValueOnce({
      saved: false,
      error: 'OS encryption is unavailable. API key storage is disabled.',
    })
    await user.type(screen.getByLabelText('API key'), 'sk-x')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(screen.getByRole('alert').textContent).toContain('OS encryption is unavailable')
  })

  it('adds folders only through the native picker and removes them', async () => {
    const { api, user } = await renderSettings({ saved: true, error: null }, ['C:\\Projects'])
    const list = screen.getByRole('list', { name: 'Granted folders' })
    expect(within(list).getByText('C:\\Projects')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add folder…' }))
    // No path argument: the main process opens the dialog and picks the folder.
    expect(api.grants.add).toHaveBeenCalledExactlyOnceWith()
    expect(within(list).getByText('D:\\Docs')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Remove C:\\Projects' }))
    expect(api.grants.remove).toHaveBeenCalledWith('C:\\Projects')
    expect(within(list).queryByText('C:\\Projects')).toBeNull()
  })

  it('reports a refused folder', async () => {
    const { api, user } = await renderSettings({ saved: true, error: null })
    api.grants.add.mockResolvedValueOnce({
      status: 'refused',
      reason: 'Granting a whole drive or file system root is not allowed.',
      grants: { roots: [], loadError: null },
    } as never)
    await user.click(screen.getByRole('button', { name: 'Add folder…' }))
    expect(screen.getByRole('alert').textContent).toContain('whole drive')
    expect(screen.getByText('No folders granted yet.')).toBeTruthy()
  })

  it('changes the model and shows the audit log location', async () => {
    const { api, user } = await renderSettings({ saved: true, error: null })
    const select = screen.getByLabelText('Model')
    expect(select).toHaveProperty('value', 'claude-sonnet-5-5')
    expect(screen.getByRole('option', { name: 'Claude Sonnet 5.5 (default)' })).toBeTruthy()
    await user.selectOptions(select, 'claude-opus-5-5')
    expect(api.model.set).toHaveBeenCalledWith('claude-opus-5-5')
    expect(select).toHaveProperty('value', 'claude-opus-5-5')
    expect(
      screen.getByText('C:\\Users\\me\\AppData\\Roaming\\desktop-agent\\audit.jsonl'),
    ).toBeTruthy()
  })
})

describe('Claude subscription sign-in', () => {
  const LINK = 'https://claude.com/cai/oauth/authorize?code=true&state=xyz'

  function ProviderHarness() {
    const [provider, setProvider] = useState<ProviderStatus>({
      provider: 'claude-subscription',
      state: 'signed-out',
      message: 'Sign in with your subscription.',
    })
    return (
      <SettingsPanel
        provider={provider}
        onProvider={setProvider}
        keyStatus={{ saved: false, error: null }}
        onKeyStatus={() => {}}
        grants={{ roots: [], loadError: null }}
        onGrants={() => {}}
        model={null}
        onModel={() => {}}
        audit={null}
      />
    )
  }

  function renderSignIn() {
    const fake = fakeApi()
    let finish: (status: ProviderStatus) => void = () => {}
    fake.api.provider.login.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const user = userEvent.setup()
    render(
      <ApiContext value={fake.api}>
        <ProviderHarness />
      </ApiContext>,
    )
    return {
      ...fake,
      user,
      finish: async (status: ProviderStatus) => {
        await act(async () => {
          finish(status)
          await Promise.resolve()
        })
      },
    }
  }

  it('shows the waiting state, the link, and asks main to copy or re-open it', async () => {
    const { api, user, pushLoginUrl, finish } = renderSignIn()
    await user.click(screen.getByRole('button', { name: 'Sign in with subscription' }))
    expect(screen.getByRole('status').textContent).toBe('Waiting for sign-in…')
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy()
    act(() => {
      pushLoginUrl({ provider: 'claude-subscription', url: LINK })
    })
    const link = screen.getByLabelText('Sign-in link')
    expect(link).toHaveProperty('value', LINK)
    expect(link).toHaveProperty('readOnly', true)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(api.provider.copyLoginUrl).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getByText('Link copied.')).toBeTruthy()
    const open = vi.spyOn(window, 'open')
    await user.click(screen.getByRole('button', { name: 'Open in browser' }))
    // No URL leaves the renderer: main re-opens the link it validated.
    expect(api.provider.openLoginUrl).toHaveBeenCalledExactlyOnceWith()
    expect(open).not.toHaveBeenCalled()
    await finish({
      provider: 'claude-subscription',
      state: 'ready',
      message: 'Subscription signed in. No API key is used.',
    })
    expect(screen.getByRole('status').textContent).toBe(
      'Subscription signed in. No API key is used.',
    )
    expect(screen.queryByLabelText('Sign-in link')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull()
  })

  it('sends a valid pasted code and rejects a malformed one locally', async () => {
    const { api, user, pushLoginUrl } = renderSignIn()
    await user.click(screen.getByRole('button', { name: 'Sign in with subscription' }))
    act(() => {
      pushLoginUrl({ provider: 'claude-subscription', url: LINK })
    })
    const code = screen.getByLabelText('Paste code')
    await user.type(code, 'not-a-code')
    await user.click(screen.getByRole('button', { name: 'Submit code' }))
    expect(api.provider.submitLoginCode).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('does not look like a sign-in code')
    await user.clear(code)
    await user.type(code, 'abc123#state')
    await user.click(screen.getByRole('button', { name: 'Submit code' }))
    expect(api.provider.submitLoginCode).toHaveBeenCalledExactlyOnceWith('abc123#state')
    expect(screen.getByText('Code sent. Finishing sign-in…')).toBeTruthy()
    api.provider.submitLoginCode.mockResolvedValueOnce({ ok: false, error: 'Rejected by main.' })
    await user.type(code, 'x#y')
    await user.click(screen.getByRole('button', { name: 'Submit code' }))
    expect(screen.getByRole('alert').textContent).toBe('Rejected by main.')
  })

  it('cancels and shows sign-in failures as alerts', async () => {
    const { api, user, finish } = renderSignIn()
    await user.click(screen.getByRole('button', { name: 'Sign in with subscription' }))
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(api.provider.cancelLogin).toHaveBeenCalledOnce()
    await finish({
      provider: 'claude-subscription',
      state: 'error',
      message: 'Claude sign-in failed (exit code 1). OAuth error',
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Claude sign-in failed (exit code 1). OAuth error')
    expect(alert.className).toBe('settings-error')
  })
})
