import type { TerminalCreateResult } from './terminal'

export type SshAuthMethod = 'privateKey' | 'password'
export type SshServerIcon = string
export const defaultSshServerIcon: SshServerIcon = 'linux'

export function normalizeSshServerIcon(value: unknown): SshServerIcon {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : defaultSshServerIcon
}

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
  defaultRemoteStartPath: string
  description: string
  host: string
  icon: SshServerIcon
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

export interface SshKnownHostsRemovalResult {
  removedHosts: string[]
}

export type SshTransferProgressStatus = 'running' | 'completed' | 'failed'

export interface SshUploadProgressEvent {
  currentPath: string | null
  percent: number
  status: SshTransferProgressStatus
  targetPath: string
  totalBytes: number
  transferredBytes: number
  uploadId: string
}

export interface SshDownloadProgressEvent {
  currentPath: string | null
  downloadId: string
  percent: number
  sourcePath: string
  status: SshTransferProgressStatus
  targetPath: string
  totalBytes: number
  transferredBytes: number
}

export interface SshRemoteTextFile {
  content: string
  path: string
  size: number
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
  onDownloadProgress: (callback: (event: SshDownloadProgressEvent) => void) => () => void
  onUploadProgress: (callback: (event: SshUploadProgressEvent) => void) => () => void
  readTextFile: (configId: string, path: string) => Promise<SshRemoteTextFile>
  removeKnownHosts: (host: string, port: number) => Promise<SshKnownHostsRemovalResult>
  renamePath: (configId: string, path: string, nextPath: string) => Promise<void>
  saveConfig: (config: SshServerConfigSaveInput) => Promise<void>
  uploadPaths: (configId: string, targetPath: string, localPaths: string[]) => Promise<void>
  writeTextFile: (configId: string, path: string, content: string) => Promise<void>
}
