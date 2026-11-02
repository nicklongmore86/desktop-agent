import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ApiContext } from '../../api'
import { fakeApi, type FakeApiOptions } from '../../test/fake-api'
import { AgentSection } from './AgentSection'

async function renderSection(options: FakeApiOptions = {}) {
  const fake = fakeApi(options)
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <AgentSection />
    </ApiContext>,
  )
  const input = screen.getByRole('spinbutton', { name: 'Steps per message' })
  await waitFor(() => {
    expect(input).toHaveProperty('disabled', false)
  })
  return { ...fake, user, input }
}

describe('Agent settings: steps per message', () => {
  it('shows the saved limit and saves a new one through main', async () => {
    const { api, user, input } = await renderSection({ turnLimit: 50 })
    expect(input).toHaveProperty('value', '50')
    await user.clear(input)
    await user.type(input, '80')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.turnLimit.set).toHaveBeenCalledExactlyOnceWith(80)
    expect((await screen.findByRole('status')).textContent).toContain(
      'It applies from your next message.',
    )
    expect(input).toHaveProperty('value', '80')
  })

  it('starts at the default of 100 and says what it covers', async () => {
    const { input } = await renderSection()
    expect(input).toHaveProperty('value', '100')
    expect(input.getAttribute('max')).toBe('300')
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toContain('From 5 to 300; the default is 100.')
    expect(hint?.textContent).toContain('pauses after 20 minutes of work on one message')
    expect(hint?.textContent).toContain('early when it appears stuck')
    expect(hint?.textContent).toContain('the notice says why')
    expect(hint?.textContent).toContain('The Claude subscription stops at its own 40 steps')
    expect(hint?.textContent).toContain('Codex uses its own limits.')
  })

  it('accepts the top of the range', async () => {
    const { api, user, input } = await renderSection()
    await user.clear(input)
    await user.type(input, '300')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.turnLimit.set).toHaveBeenCalledExactlyOnceWith(300)
  })

  it.each(['4', '301', '12.5', ''])('refuses %j without asking main', async (value) => {
    const { api, user, input } = await renderSection()
    await user.clear(input)
    if (value) await user.type(input, value)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.turnLimit.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      'Choose a whole number of steps from 5 to 300.',
    )
  })

  it('says so when main refuses to save', async () => {
    const { api, user, input } = await renderSection()
    api.turnLimit.set.mockRejectedValueOnce(new Error('Choose a whole number of steps.'))
    await user.clear(input)
    await user.type(input, '20')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The limit could not be saved. Try again.',
    )
  })
})
