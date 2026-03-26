export interface LocalRestorableTabState {
  cwd?: string
  kind: 'local'
}

export interface SshRestorableTabState {
  browserPath?: string
  configId: string
  cwd?: string
  kind: 'ssh'
}

export type RestorableTabState = LocalRestorableTabState | SshRestorableTabState

export interface SessionTabSnapshot {
  id: string
  outputLines?: string[]
  restoreState: RestorableTabState
  title: string
}

export interface SessionSnapshot {
  activeTabId: string | null
  tabs: SessionTabSnapshot[]
  version: 1
}

export interface SessionApi {
  load: () => Promise<SessionSnapshot | null>
  save: (snapshot: SessionSnapshot) => Promise<void>
}
