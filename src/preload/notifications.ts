import { notificationsChannels, type NotificationsApi } from '../shared/ipc-notifications'
import type { Invoke } from './features'

export const notificationsApi = (invoke: Invoke): NotificationsApi => ({
  notifications: {
    get: () => invoke(notificationsChannels.notificationsGet),
    set: (enabled) => invoke(notificationsChannels.notificationsSet, enabled),
  },
})
