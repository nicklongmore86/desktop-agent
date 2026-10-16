/**
 * Registers the per-feature IPC modules (see docs/ipc-modules.md). Add one import,
 * one service in FeatureServices and one call below, in alphabetical order.
 */
import { registerLayoutHandlers, type LayoutService } from './ipc-layout'
import { registerProjectsHandlers, type ProjectsService } from './ipc-projects'

/** Registers a handler that has already passed the trusted-sender check. */
export type IpcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => void

export interface FeatureServices {
  layout: LayoutService
  projects: ProjectsService
}

export function registerFeatureHandlers(handle: IpcHandle, services: FeatureServices): void {
  registerLayoutHandlers(handle, services.layout)
  registerProjectsHandlers(handle, services.projects)
}
