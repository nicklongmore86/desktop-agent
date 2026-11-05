import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The placeholder icon as a PNG for the window and notifications: beside the app's other
 * resources when installed (electron-builder.yml extraResources), assets/icon in a checkout.
 * Undefined when the file is missing, so Electron's default is used rather than failing.
 * The .ico that the installer and the .exe carry is built from the same source.
 */
export function appIconPath(): string | undefined {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'assets/icon/icon.png')
  return existsSync(path) ? path : undefined
}
