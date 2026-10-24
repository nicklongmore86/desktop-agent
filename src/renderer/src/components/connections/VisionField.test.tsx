import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, ConnectionVision } from '../../../../shared/ipc-connections'
import { ApiContext } from '../../api'
import { VISION_CHANGED } from '../../attachments/use-vision'
import { fakeApi } from '../../test/fake-api'
import { VisionField } from './VisionField'

const ollama = {
  id: 'ollama',
  vendor: 'local',
  access: 'free',
  label: 'Ollama',
  shortLabel: 'Ollama',
  title: 'Ollama',
  description: '',
  capabilities: { authKind: 'local', listsModels: true, reportsUsage: false, needsRuntime: false },
  personalUseOnly: false,
  pickerOrder: 6,
} satisfies ConnectionInfo

function show(vision?: ConnectionVision) {
  const { api } = fakeApi(vision ? { vision: { ollama: vision } } : {})
  render(
    <ApiContext value={api}>
      <VisionField connection={ollama} />
    </ApiContext>,
  )
  return api
}

describe('VisionField', () => {
  it('saves "This model can see images" and tells the composer to ask again', async () => {
    const api = show()
    const changed = vi.fn()
    window.addEventListener(VISION_CHANGED, changed)
    const box = await screen.findByRole<HTMLInputElement>('checkbox', {
      name: 'This model can see images',
    })
    expect(box.checked).toBe(false)
    await userEvent.click(box)
    expect(api.connections.setVision).toHaveBeenCalledWith('ollama', true)
    await waitFor(() => {
      expect(changed).toHaveBeenCalledOnce()
    })
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', { name: 'This model can see images' })
          .checked,
      ).toBe(true)
    })
    window.removeEventListener(VISION_CHANGED, changed)
  })

  it('shows what the model list says instead of the switch, and nothing where it cannot apply', async () => {
    show({ enabled: true, source: 'model', setting: false, configurable: true })
    expect(await screen.findByText(/The selected model can see images/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
