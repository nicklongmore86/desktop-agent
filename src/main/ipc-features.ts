/**
 * Registers the per-feature IPC modules (see docs/ipc-modules.md). Add one import,
 * one service in FeatureServices and one call below, in alphabetical order.
 */
import { registerAttachmentsHandlers, type AttachmentsService } from './ipc-attachments'
import { registerCommandHandlers, type CommandService } from './ipc-command'
import { registerConnectionsHandlers, type ConnectionsService } from './ipc-connections'
import { registerFilesHandlers, type FilesService } from './ipc-files'
import { registerGitHandlers, type GitService } from './ipc-git'
import { registerLayoutHandlers, type LayoutService } from './ipc-layout'
import { registerNotificationsHandlers, type NotificationsService } from './ipc-notifications'
import { registerOcrIndexHandlers, type OcrIndexIpcService } from './ipc-ocr-index'
import { registerProjectsHandlers, type ProjectsService } from './ipc-projects'

/** Registers a handler that has already passed the trusted-sender check. */
export type IpcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => void

export interface FeatureServices {
  attachments: AttachmentsService
  command: CommandService
  connections: ConnectionsService
  files: FilesService
  git: GitService
  layout: LayoutService
  notifications: NotificationsService
  ocrIndex: OcrIndexIpcService
  projects: ProjectsService
}

export function registerFeatureHandlers(handle: IpcHandle, services: FeatureServices): void {
  registerAttachmentsHandlers(handle, services.attachments)
  registerCommandHandlers(handle, services.command)
  registerConnectionsHandlers(handle, services.connections)
  registerFilesHandlers(handle, services.files)
  registerGitHandlers(handle, services.git)
  registerLayoutHandlers(handle, services.layout)
  registerNotificationsHandlers(handle, services.notifications)
  registerOcrIndexHandlers(handle, services.ocrIndex)
  registerProjectsHandlers(handle, services.projects, services.connections)
}
