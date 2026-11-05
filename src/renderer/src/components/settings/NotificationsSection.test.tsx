import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ApiContext } from '../../api'
import { fakeApi, type FakeApiOptions } from '../../test/fake-api'
import { NotificationsSection } from './NotificationsSection'

async function renderSection(options: FakeApiOptions = {}) {
  const fake = fakeApi(options)
  const user = userEvent.setup()
  render(
    <ApiContext value={fake.api}>
      <NotificationsSection />
    </ApiContext>,
  )
  const box = screen.getByRole('checkbox', { name: 'Notify me when Desktop Agent needs me' })
  await waitFor(() => {
    expect(box).toHaveProperty('disabled', false)
  })
  return { ...fake, user, box }
}

describe('Notifications settings', () => {
  it('is on by default', async () => {
    const { box } = await renderSection()
    expect(box).toHaveProperty('checked', true)
  })

  it('shows a saved off choice and turns it on and off through main', async () => {
    const { api, user, box } = await renderSection({ notifications: false })
    expect(box).toHaveProperty('checked', false)
    await user.click(box)
    await waitFor(() => {
      expect(box).toHaveProperty('checked', true)
    })
    expect(api.notifications.set).toHaveBeenLastCalledWith(true)
    await user.click(box)
    await waitFor(() => {
      expect(box).toHaveProperty('checked', false)
    })
    expect(api.notifications.set).toHaveBeenLastCalledWith(false)
  })

  it('says the notification shows no content and cannot answer an approval', async () => {
    const { box } = await renderSection()
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toContain('never shows your messages')
    expect(hint?.textContent).toContain('Approvals are always answered in the window')
  })

  it('reports a failed save and keeps the old value', async () => {
    const { api, user, box } = await renderSection()
    api.notifications.set.mockRejectedValueOnce(new Error('disk'))
    await user.click(box)
    expect((await screen.findByRole('alert')).textContent).toContain('could not be saved')
    expect(box).toHaveProperty('checked', true)
  })
})
