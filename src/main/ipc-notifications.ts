import { notificationsChannels } from '../shared/ipc-notifications'
import type { IpcHandle } from './ipc-features'

export interface NotificationsService {
  get: () => boolean
  set: (enabled: boolean) => Promise<boolean>
}

export function registerNotificationsHandlers(
  handle: IpcHandle,
  notifications: NotificationsService,
): void {
  handle(notificationsChannels.notificationsGet, () => notifications.get())
  handle(notificationsChannels.notificationsSet, (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid choice.')
    return notifications.set(enabled)
  })
}
