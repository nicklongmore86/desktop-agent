/**
 * Window layout preferences (sidebars): channel names, types and limits shared by
 * main, preload and renderer. One of the per-feature IPC modules; see docs/ipc-modules.md.
 *
 * No zod here, so the renderer bundle stays small. Main validates in
 * src/main/storage/layout-schema.ts; the renderer only ever receives validated data.
 */
export const layoutChannels = {
  layoutGet: 'layout:get',
  layoutSet: 'layout:set',
} as const

/** The tabs of the right-hand Workspace panel. */
export const RIGHT_TABS = ['files', 'git'] as const
export type RightTabId = (typeof RIGHT_TABS)[number]

export const LAYOUT_VERSION = 1

/** Pane widths in CSS pixels. The real maximum also depends on the window (see layout.ts). */
export const LEFT_MIN = 220
export const LEFT_DEFAULT = 272
export const RIGHT_MIN = 240
export const RIGHT_DEFAULT = 320
/** Hard cap on any stored width, whatever the window size. */
export const PANE_MAX = 1200

/**
 * The sidebar layout. Global (not per chat) and kept across restarts. It holds
 * numbers, booleans and a tab id only: never a path. New fields go in additively
 * with a default in layout-schema.ts; bump LAYOUT_VERSION only for a breaking change.
 */
export interface LayoutPrefs {
  version: typeof LAYOUT_VERSION
  leftOpen: boolean
  leftWidth: number
  rightOpen: boolean
  rightWidth: number
  rightTab: RightTabId
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  version: LAYOUT_VERSION,
  leftOpen: true,
  leftWidth: LEFT_DEFAULT,
  rightOpen: true,
  rightWidth: RIGHT_DEFAULT,
  rightTab: 'files',
}

export interface LayoutApi {
  layout: {
    get: () => Promise<LayoutPrefs>
    /** Saves the layout (main validates it) and answers with what is now stored. */
    set: (layout: LayoutPrefs) => Promise<LayoutPrefs>
  }
}
