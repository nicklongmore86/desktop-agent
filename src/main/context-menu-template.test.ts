import { describe, expect, it } from 'vitest'
import { contextMenuTemplate, type ContextMenuParams } from './context-menu-template'

const ALL = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
}

function params(over: Partial<ContextMenuParams>): ContextMenuParams {
  return { isEditable: false, selectionText: '', formControlType: 'none', editFlags: ALL, ...over }
}

const roles = (p: ContextMenuParams): (string | undefined)[] =>
  contextMenuTemplate(p).map((i) => (i.type === 'separator' ? '-' : i.role))

describe('contextMenuTemplate', () => {
  it('offers the full edit set in an editable field', () => {
    expect(roles(params({ isEditable: true, formControlType: 'text-area' }))).toEqual([
      'undo',
      'redo',
      '-',
      'cut',
      'copy',
      'paste',
      '-',
      'selectAll',
    ])
  })

  it('enables each item from the matching editFlag', () => {
    const none = { ...ALL, canUndo: false, canRedo: false, canCut: false, canCopy: false }
    const items = contextMenuTemplate(
      params({ isEditable: true, editFlags: { ...none, canPaste: false } }),
    )
    const enabled: Record<string, boolean | undefined> = {}
    for (const i of items) if (i.role) enabled[i.role] = i.enabled
    expect(enabled).toEqual({
      undo: false,
      redo: false,
      cut: false,
      copy: false,
      paste: false,
      selectAll: true,
    })
    const some = contextMenuTemplate(
      params({ isEditable: true, editFlags: { ...none, canCut: true, canPaste: true } }),
    )
    expect(some.find((i) => i.role === 'cut')?.enabled).toBe(true)
    expect(some.find((i) => i.role === 'paste')?.enabled).toBe(true)
    expect(some.find((i) => i.role === 'copy')?.enabled).toBe(false)
  })

  it('never offers Cut or Copy in a password field, but keeps Paste', () => {
    const r = roles(
      params({ isEditable: true, formControlType: 'input-password', selectionText: 'x' }),
    )
    expect(r).not.toContain('cut')
    expect(r).not.toContain('copy')
    expect(r).toContain('paste')
  })

  it('offers Copy and Select All for selected read-only text', () => {
    const items = contextMenuTemplate(params({ selectionText: 'hello' }))
    expect(items.map((i) => i.role)).toEqual(['copy', 'selectAll'])
    const off = contextMenuTemplate(
      params({ selectionText: 'hello', editFlags: { ...ALL, canCopy: false } }),
    )
    expect(off[0]?.enabled).toBe(false)
  })

  it('shows nothing without a selection when not editable', () => {
    expect(contextMenuTemplate(params({}))).toEqual([])
  })

  it('shows nothing for a selection inside a read-only password field', () => {
    expect(
      contextMenuTemplate(params({ formControlType: 'input-password', selectionText: 'x' })),
    ).toEqual([])
  })

  it('only ever uses standard edit roles', () => {
    const allowed = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    for (const p of [
      params({ isEditable: true }),
      params({ selectionText: 'a' }),
      params({ isEditable: true, formControlType: 'input-password' }),
    ]) {
      for (const item of contextMenuTemplate(p)) {
        if (item.type === 'separator') continue
        expect(allowed.has(item.role ?? '')).toBe(true)
        expect(item.click).toBeUndefined()
      }
    }
  })
})
