/** The Settings sections the chat can open directly. */
export type SettingsSection = 'accounts' | 'folders' | 'appearance' | 'privacy' | 'about'

/** Opens Settings, on a section when one is given. */
export type OpenSettings = (section?: SettingsSection) => void
