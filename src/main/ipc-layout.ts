import { layoutChannels, type LayoutPrefs } from '../shared/ipc-layout'
import type { IpcHandle } from './ipc-features'

export interface LayoutService {
  get: () => LayoutPrefs
  /** Validates and saves; unknown keys are dropped and bad fields reset to their defaults. */
  set: (layout: unknown) => Promise<LayoutPrefs>
}

export function registerLayoutHandlers(handle: IpcHandle, layout: LayoutService): void {
  handle(layoutChannels.layoutGet, () => layout.get())
  handle(layoutChannels.layoutSet, (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('Invalid layout.')
    return layout.set(value)
  })
}
