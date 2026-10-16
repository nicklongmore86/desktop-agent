/**
 * Registers the per-feature IPC modules (see docs/ipc-modules.md). Add one import,
 * one service in FeatureServices and one call below, in alphabetical order.
 */
import { registerFilesHandlers, type FilesService } from './ipc-files'
import { registerLayoutHandlers, type LayoutService } from './ipc-layout'

/** Registers a handler that has already passed the trusted-sender check. */
export type IpcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => void

export interface FeatureServices {
  files: FilesService
  layout: LayoutService
}

export function registerFeatureHandlers(handle: IpcHandle, services: FeatureServices): void {
  registerFilesHandlers(handle, services.files)
  registerLayoutHandlers(handle, services.layout)
}
