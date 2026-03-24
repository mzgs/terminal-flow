import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { SshApi, SshServerConfig } from '../shared/ssh'
import type {
  TerminalApi,
  TerminalCreateOptions,
  TerminalCwdEvent,
  TerminalDataEvent,
  TerminalExitEvent
} from '../shared/terminal'

// Custom APIs for renderer
const terminal: TerminalApi = {
  create: (options?: TerminalCreateOptions) => ipcRenderer.invoke('terminal:create', options),
  write: (terminalId, data) => ipcRenderer.send('terminal:write', { terminalId, data }),
  resize: (terminalId, cols, rows) =>
    ipcRenderer.send('terminal:resize', { terminalId, cols, rows }),
  kill: (terminalId) => ipcRenderer.send('terminal:kill', terminalId),
  onData: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => {
      callback(payload)
    }

    ipcRenderer.on('terminal:data', listener)

    return () => {
      ipcRenderer.off('terminal:data', listener)
    }
  },
  onCwd: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalCwdEvent): void => {
      callback(payload)
    }

    ipcRenderer.on('terminal:cwd', listener)

    return () => {
      ipcRenderer.off('terminal:cwd', listener)
    }
  },
  onExit: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent): void => {
      callback(payload)
    }

    ipcRenderer.on('terminal:exit', listener)

    return () => {
      ipcRenderer.off('terminal:exit', listener)
    }
  }
}

const ssh: SshApi = {
  listConfigs: () => ipcRenderer.invoke('ssh:list-configs'),
  saveConfig: (config) => ipcRenderer.invoke('ssh:save-config', config),
  onConfigAdded: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SshServerConfig): void => {
      callback(payload)
    }

    ipcRenderer.on('ssh:config-added', listener)

    return () => {
      ipcRenderer.off('ssh:config-added', listener)
    }
  }
}

const api = {
  ssh,
  terminal,
  webUtils: {
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
