import type { TerminalCreateResult } from './terminal'

export type SshAuthMethod = 'privateKey' | 'password'

export interface SshRemoteDirectoryEntry {
  isDirectory: boolean
  name: string
}

export interface SshRemoteDirectoryListing {
  entries: SshRemoteDirectoryEntry[]
  path: string
}

export interface SshServerConfigInput {
  authMethod: SshAuthMethod
  description: string
  host: string
  name: string
  password: string
  privateKeyPath: string
  port: number
  username: string
}

export interface SshServerConfig extends SshServerConfigInput {
  id: string
}

export interface SshServerConfigSaveInput extends SshServerConfigInput {
  id?: string
}

export type SshUploadProgressStatus = 'running' | 'completed' | 'failed'

export interface SshUploadProgressEvent {
  currentPath: string | null
  percent: number
  status: SshUploadProgressStatus
  targetPath: string
  totalBytes: number
  transferredBytes: number
  uploadId: string
}

export interface SshApi {
  connect: (configId: string, cwd?: string) => Promise<TerminalCreateResult>
  deleteConfig: (configId: string) => Promise<void>
  deletePath: (configId: string, path: string, isDirectory: boolean) => Promise<void>
  downloadPath: (configId: string, path: string, isDirectory: boolean) => Promise<string>
  listDirectory: (configId: string, path?: string) => Promise<SshRemoteDirectoryListing>
  listConfigs: () => Promise<SshServerConfig[]>
  onConfigAdded: (callback: (config: SshServerConfig) => void) => () => void
  onConfigDeleted: (callback: (configId: string) => void) => () => void
  onUploadProgress: (callback: (event: SshUploadProgressEvent) => void) => () => void
  renamePath: (configId: string, path: string, nextPath: string) => Promise<void>
  saveConfig: (config: SshServerConfigSaveInput) => Promise<void>
  uploadPaths: (configId: string, targetPath: string, localPaths: string[]) => Promise<void>
}
