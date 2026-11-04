/**
 * The notifications setting: channel names and the API shape shared by main, preload and
 * renderer. One of the per-feature IPC modules; see docs/ipc-modules.md.
 *
 * It switches the native notification and the taskbar flash that tell the user a reply
 * finished or failed, or an approval is waiting, while the window is not in front. Default on.
 */
export const notificationsChannels = {
  notificationsGet: 'notifications:get',
  notificationsSet: 'notifications:set',
} as const

export interface NotificationsApi {
  notifications: {
    get: () => Promise<boolean>
    /** Resolves to the saved value. */
    set: (enabled: boolean) => Promise<boolean>
  }
}
