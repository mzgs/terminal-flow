import { ElectronAPI } from '@electron-toolkit/preload'
import type { AutomationApi } from '../shared/automation'
import type { ClipboardApi } from '../shared/clipboard'
import type { SettingsApi } from '../shared/settings'
import type { SessionApi } from '../shared/session'
import type { ShellApi } from '../shared/shell'
import type { SshApi } from '../shared/ssh'
import type { TerminalApi } from '../shared/terminal'

interface WebUtilsApi {
  getPathForFile: (file: File) => string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      automation: AutomationApi
      clipboard: ClipboardApi
      settings: SettingsApi
      session: SessionApi
      shell: ShellApi
      ssh: SshApi
      terminal: TerminalApi
      webUtils: WebUtilsApi
    }
  }
}
