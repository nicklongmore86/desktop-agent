import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ProviderAllowance, ProviderResult } from '../../../../shared/ipc'
import { ApiContext } from '../../api'
import { fakeApi } from '../../test/fake-api'
import { UsageSection } from './UsageSection'

const allowance: ProviderAllowance = {
  provider: 'codex-subscription',
  plan: 'Plus',
  state: 'available',
  resetsAt: null,
  windows: [{ limitId: 'Five hour', remainingPercent: 15, resetsAt: '2026-10-20T15:00:00Z' }],
  lastError: null,
}
describe('Accounts usage', () => {
  it('shows advisory usage and refreshes a limited window without gating anything', async () => {
    const { api } = fakeApi()
    api.provider.allowance.mockResolvedValue({
      ok: true,
      value: { ...allowance, credits: { hasCredits: true, unlimited: false } },
    })
    render(
      <ApiContext value={api}>
        <UsageSection provider="codex-subscription" />
      </ApiContext>,
    )
    expect(await screen.findByText('Plus')).toBeTruthy()
    expect(screen.getByText('Available')).toBeTruthy()
    expect(screen.getByText('Credits available')).toBeTruthy()
    expect(screen.getByText('Five hour · 85% used')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('85')
    api.provider.allowance.mockResolvedValue({
      ok: true,
      value: { ...allowance, state: 'limited', resetsAt: '2026-10-20T15:00:00Z' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText(/Limit reached — resets/)).toBeTruthy()
  })
  it('shows Claude last known state without inventing percentages', async () => {
    const { api } = fakeApi()
    api.provider.allowance.mockResolvedValue({
      ok: true,
      value: { ...allowance, provider: 'claude-subscription', plan: 'Pro', windows: [] },
    })
    render(
      <ApiContext value={api}>
        <UsageSection provider="claude-subscription" />
      </ApiContext>,
    )
    expect(await screen.findByText('Pro')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText(/does not report usage percentages/)).toBeTruthy()
    expect(api.provider.models).not.toHaveBeenCalled()
  })
  it('shows operational failures and ignores a late response after unmount', async () => {
    const { api } = fakeApi()
    let resolve!: (value: ProviderResult<ProviderAllowance>) => void
    api.provider.allowance.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const view = render(
      <ApiContext value={api}>
        <UsageSection provider="codex-subscription" />
      </ApiContext>,
    )
    view.unmount()
    await act(async () => {
      resolve({ ok: true, value: allowance })
      await Promise.resolve()
    })
    api.provider.allowance.mockRejectedValue(new Error('offline'))
    render(
      <ApiContext value={api}>
        <UsageSection provider="codex-subscription" />
      </ApiContext>,
    )
    await waitFor(() => {
      expect(api.provider.allowance).toHaveBeenCalledTimes(2)
    })
    expect(screen.getAllByText('Usage unavailable right now').length).toBeGreaterThan(0)
  })
  it('selects a Codex model, retains fallback copy, and handles failures', async () => {
    const { api } = fakeApi()
    const models = {
      provider: 'codex-subscription' as const,
      options: [
        {
          id: 'terra',
          label: 'Terra',
          isDefault: true,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
        },
      ],
      selectedModel: null,
      savedModel: 'gone',
      defaultModel: 'terra',
      resolvedModel: 'terra',
    }
    api.provider.models.mockResolvedValue({ ok: true, value: models })
    api.provider.setModel.mockResolvedValue({
      ok: true,
      value: { ...models, selectedModel: 'terra', savedModel: 'terra' },
    })
    render(
      <ApiContext value={api}>
        <UsageSection provider="codex-subscription" />
      </ApiContext>,
    )
    expect(await screen.findByText('Using default model')).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText('Codex model'), 'terra')
    expect(api.provider.setModel).toHaveBeenCalledWith('terra')
    await waitFor(() => {
      expect(screen.queryByText('Using default model')).toBeNull()
    })
    api.provider.setModel.mockResolvedValue({
      ok: false,
      failure: { code: 'model_unavailable', message: 'Model unavailable' },
    })
    await userEvent.selectOptions(screen.getByLabelText('Codex model'), '')
    expect(await screen.findByText('Model unavailable')).toBeTruthy()
  })
})
