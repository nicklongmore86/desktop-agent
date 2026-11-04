import { BrowserWindow, clipboard, dialog, Menu, type WebContents } from 'electron'
import { linkMismatch, plainDestination } from '../shared/web-link-mismatch'
import { openWebLink } from './web-links'
import { contextMenuTemplate } from './context-menu-template'

export interface ContextMenuOptions {
  /**
   * True while an approval is waiting for the user. Read from the main process's own state
   * (never from the page): Open Link is not offered then, and a click on it that was already
   * on screen does nothing. Same rule as clicks in a reply, which are held then.
   */
  approvalOpen: () => boolean
}

/**
 * Shows the native text menu for right-clicks in this window's page. Pages that handle
 * the click themselves (preventDefault on 'contextmenu') never reach this event.
 * Spellcheck is off in the app's web preferences, so there are no suggestions to offer.
 *
 * Open Link applies the same rule as a left-click on a link in a reply (the shared
 * `linkMismatch`): when the link's text names another site than it goes to, a native
 * confirmation names the real destination first, with Cancel as the default. The text and
 * the target are the ones Chromium reports for the element under the cursor.
 */
export function attachContextMenu(contents: WebContents, options: ContextMenuOptions): void {
  let confirming = false

  const open = async (linkURL: string, linkText: string): Promise<void> => {
    if (options.approvalOpen() || confirming) return
    const mismatch = linkMismatch(linkText, linkURL)
    if (mismatch !== null) {
      confirming = true
      try {
        const window = BrowserWindow.fromWebContents(contents)
        const box = {
          type: 'warning' as const,
          title: 'Open this link?',
          message: 'The link text names a different site than the link goes to.',
          detail:
            `The text says: ${mismatch.claimed}\n` +
            `It really goes to: ${mismatch.host}\n\n` +
            plainDestination(linkURL),
          buttons: ['Cancel', 'Open in browser'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        }
        const answer = window
          ? await dialog.showMessageBox(window, box)
          : await dialog.showMessageBox(box)
        if (answer.response !== 1) return
      } finally {
        confirming = false
      }
      // An approval may have arrived while the question was open.
      if (options.approvalOpen()) return
    }
    openWebLink(linkURL)
  }

  contents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, {
      ...(options.approvalOpen()
        ? {}
        : {
            open: (url: string) => {
              void open(url, params.linkText)
            },
          }),
      copy: (url) => {
        void clipboard.writeText(url)
      },
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup()
  })
}
