import { Menu, type WebContents } from 'electron'
import { contextMenuTemplate } from './context-menu-template'

/**
 * Shows the native text menu for right-clicks in this window's page. Pages that handle
 * the click themselves (preventDefault on 'contextmenu') never reach this event.
 * Spellcheck is off in the app's web preferences, so there are no suggestions to offer.
 */
export function attachContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params)
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup()
  })
}
