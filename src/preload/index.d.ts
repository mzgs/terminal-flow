import { ElectronAPI } from '@electron-toolkit/preload'
import type { SshApi } from '../shared/ssh'
import type { TerminalApi } from '../shared/terminal'

interface WebUtilsApi {
  getPathForFile: (file: File) => string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      ssh: SshApi
      terminal: TerminalApi
      webUtils: WebUtilsApi
    }
  }
}
