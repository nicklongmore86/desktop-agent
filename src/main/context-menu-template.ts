import type { MenuItemConstructorOptions } from 'electron'
import { isWebLink } from './web-link-rule'

/**
 * The part of Electron's 'context-menu' params the menu depends on. Chromium reports these
 * from the page's real focus/selection state; nothing here is chosen by renderer code.
 */
export interface ContextMenuParams {
  /** The link under the cursor, resolved by Chromium; '' when there is none. */
  linkURL?: string
  isEditable: boolean
  selectionText: string
  /** 'input-password' for <input type="password">; 'none' outside a form control. */
  formControlType?: string
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

/**
 * The native right-click menu for a text context: standard edit roles only, nothing that
 * navigates, opens, or inspects. Returns [] when there is nothing useful to offer.
 */
export interface LinkActions {
  open: (url: string) => void
  copy: (url: string) => void
}

/** Only http(s) links get link items; the same rule as opening a link by left-click. */
function linkItems(params: ContextMenuParams, links: LinkActions): MenuItemConstructorOptions[] {
  const url = params.linkURL ?? ''
  if (!isWebLink(url)) return []
  return [
    {
      label: 'Open Link',
      click: () => {
        links.open(url)
      },
    },
    {
      label: 'Copy Link Address',
      click: () => {
        links.copy(url)
      },
    },
  ]
}

export function contextMenuTemplate(
  params: ContextMenuParams,
  links?: LinkActions,
): MenuItemConstructorOptions[] {
  const link = links ? linkItems(params, links) : []
  const rest = editTemplate(params)
  return link.length > 0 && rest.length > 0
    ? [...link, { type: 'separator' }, ...rest]
    : [...link, ...rest]
}

function editTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  // A secret field never offers Cut or Copy; Paste (into an editable one) still works.
  const secret = params.formControlType === 'input-password'

  if (params.isEditable) {
    const items: MenuItemConstructorOptions[] = [
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
    ]
    if (!secret) {
      items.push({ role: 'cut', enabled: flags.canCut }, { role: 'copy', enabled: flags.canCopy })
    }
    items.push(
      { role: 'paste', enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: flags.canSelectAll },
    )
    return items
  }

  if (secret || params.selectionText.length === 0) return []
  return [
    { role: 'copy', enabled: flags.canCopy },
    { role: 'selectAll', enabled: flags.canSelectAll },
  ]
}
