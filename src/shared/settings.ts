export type AppStartupMode = 'restorePreviousSession' | 'startClean'
export type TerminalCursorStyle = 'bar' | 'block' | 'underline'

export interface GeneralSettings {
  defaultNewTabDirectory: string
  startupMode: AppStartupMode
}

export interface TerminalAppearanceSettings {
  colorSchemeId: string
  cursorBlink: boolean
  cursorColor: string | null
  selectionColor: string | null
  cursorStyle: TerminalCursorStyle
  cursorWidth: number
  fontFamilyId: string
  fontSize: number
  fontWeight: string
  lineHeight: number
}

export interface AppSettings {
  general: GeneralSettings
  terminal: TerminalAppearanceSettings
  version: 1
}

export interface SettingsApi {
  load: () => Promise<AppSettings | null>
  save: (settings: AppSettings) => Promise<void>
}
