import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { setViewport } from './viewport'

// jsdom has no layout, so it does not implement scrolling.
Element.prototype.scrollIntoView = function scrollIntoView() {}

// jsdom does not implement checkVisibility; without layout everything attached counts as visible.
HTMLElement.prototype.checkVisibility = function checkVisibility() {
  return this.isConnected
}

// Pointer capture (the resize handle) is not implemented by jsdom.
Element.prototype.setPointerCapture = function setPointerCapture() {}
Element.prototype.releasePointerCapture = function releasePointerCapture() {}

afterEach(() => {
  cleanup()
  setViewport(1024)
})

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
})
