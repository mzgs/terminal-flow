import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { SessionApi } from '../shared/session'
import type { ShellApi } from '../shared/shell'
import type { SshApi, SshRemoteDirectoryListing, SshServerConfig } from '../shared/ssh'
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
  onFindRequested: (callback) => {
    const listener = (): void => {
      callback()
    }

    ipcRenderer.on('terminal:find-requested', listener)

    return () => {
      ipcRenderer.off('terminal:find-requested', listener)
    }
  },
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

const session: SessionApi = {
  load: () => ipcRenderer.invoke('session:load'),
  save: (snapshot) => ipcRenderer.invoke('session:save', snapshot)
}

const shell: ShellApi = {
  openPath: (path) => ipcRenderer.invoke('shell:open-path', path)
}

const ssh: SshApi = {
  connect: (configId, cwd) => ipcRenderer.invoke('ssh:connect', { configId, cwd }),
  deleteConfig: (configId) => ipcRenderer.invoke('ssh:delete-config', configId),
  deletePath: (configId, path, isDirectory) =>
    ipcRenderer.invoke('ssh:delete-path', {
      configId,
      isDirectory,
      path
    }),
  downloadPath: (configId, path, isDirectory) =>
    ipcRenderer.invoke('ssh:download-path', {
      configId,
      isDirectory,
      path
    }) as Promise<string>,
  listDirectory: (configId, path) =>
    ipcRenderer.invoke('ssh:list-directory', {
      configId,
      path
    }) as Promise<SshRemoteDirectoryListing>,
  listConfigs: () => ipcRenderer.invoke('ssh:list-configs'),
  renamePath: (configId, path, nextPath) =>
    ipcRenderer.invoke('ssh:rename-path', {
      configId,
      nextPath,
      path
    }),
  saveConfig: (config) => ipcRenderer.invoke('ssh:save-config', config),
  uploadPaths: (configId, targetPath, localPaths) =>
    ipcRenderer.invoke('ssh:upload-paths', {
      configId,
      localPaths,
      targetPath
    }),
  onConfigAdded: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SshServerConfig): void => {
      callback(payload)
    }

    ipcRenderer.on('ssh:config-added', listener)

    return () => {
      ipcRenderer.off('ssh:config-added', listener)
    }
  },
  onConfigDeleted: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string): void => {
      callback(payload)
    }

    ipcRenderer.on('ssh:config-deleted', listener)

    return () => {
      ipcRenderer.off('ssh:config-deleted', listener)
    }
  }
}

const api = {
  session,
  shell,
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
