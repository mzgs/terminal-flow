import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { TerminalApi, TerminalDataEvent, TerminalExitEvent } from '../shared/terminal'

// Custom APIs for renderer
const terminal: TerminalApi = {
  create: () => ipcRenderer.invoke('terminal:create'),
  write: (terminalId, data) => ipcRenderer.send('terminal:write', { terminalId, data }),
  resize: (terminalId, cols, rows) => ipcRenderer.send('terminal:resize', { terminalId, cols, rows }),
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

const api = { terminal }

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
