export type AppStartupMode = 'restorePreviousSession' | 'startClean'
export type SftpBrowserOpenMode = 'restoreLastSession' | 'openCurrentFolder'
export type TerminalCursorStyle = 'bar' | 'block' | 'underline'

export interface GeneralSettings {
  defaultNewTabDirectory: string
  sftpBrowserOpenMode: SftpBrowserOpenMode
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

export interface QuickCommand {
  command: string
  id: string
  title: string
}

export interface AppSettings {
  general: GeneralSettings
  quickCommands: QuickCommand[]
  terminal: TerminalAppearanceSettings
  version: 1
}

export interface SettingsImportResult {
  filePath: string
  settings: AppSettings
}

export interface SettingsExportResult {
  filePath: string
}

export interface SettingsApi {
  exportToFile: () => Promise<SettingsExportResult | null>
  importFromFile: () => Promise<SettingsImportResult | null>
  load: () => Promise<AppSettings | null>
  save: (settings: AppSettings) => Promise<void>
}
