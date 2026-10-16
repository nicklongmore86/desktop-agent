/**
 * Registers the per-feature IPC modules (see docs/ipc-modules.md). Add one import,
 * one service in FeatureServices and one call below, in alphabetical order.
 */
import { registerCommandHandlers, type CommandService } from './ipc-command'
import { registerLayoutHandlers, type LayoutService } from './ipc-layout'

/** Registers a handler that has already passed the trusted-sender check. */
export type IpcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => void

export interface FeatureServices {
  command: CommandService
  layout: LayoutService
}

export function registerFeatureHandlers(handle: IpcHandle, services: FeatureServices): void {
  registerCommandHandlers(handle, services.command)
  registerLayoutHandlers(handle, services.layout)
}
