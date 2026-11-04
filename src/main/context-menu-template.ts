import type { MenuItemConstructorOptions } from 'electron'

/**
 * The part of Electron's 'context-menu' params the menu depends on. Chromium reports these
 * from the page's real focus/selection state; nothing here is chosen by renderer code.
 */
export interface ContextMenuParams {
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
export function contextMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
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
