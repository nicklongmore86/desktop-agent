import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ErrorBanner } from './ErrorBanner'

it.each([
  ['usage_limit', 'Plan limit reached'],
  ['plan_not_entitled', 'Plan upgrade required'],
  ['model_unavailable', 'Model unavailable'],
  ['auth_expired', 'Sign-in expired'],
  ['runtime_unavailable', 'Runtime unavailable'],
] as const)('offers Settings for %s and preserves safe provider copy', (code, title) => {
  const open = vi.fn()
  render(
    <ErrorBanner
      banner={{ code, message: 'Safe provider explanation. It resets at 3:40 PM.' }}
      onOpenSettings={open}
      onDismiss={vi.fn()}
      onNewChat={vi.fn()}
    />,
  )
  expect(screen.getByRole('alert').textContent).toContain(title)
  expect(screen.getByRole('alert').textContent).toContain('It resets at 3:40 PM.')
  fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
  expect(open).toHaveBeenCalledOnce()
})
