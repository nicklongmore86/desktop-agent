/** IPC channel names shared by the main process and the preload script. */
export const IpcChannels = {
  getAppInfo: 'app:get-info',
} as const

export interface AppInfo {
  name: string
  version: string
  platform: string
}

/** The API the preload script exposes to the renderer as `window.desktopApi`. */
export interface DesktopApi {
  getAppInfo: () => Promise<AppInfo>
}
