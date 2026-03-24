import { ElectronAPI } from '@electron-toolkit/preload'
import type { TerminalApi } from '../shared/terminal'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      terminal: TerminalApi
    }
  }
}
