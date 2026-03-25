import type { TerminalCreateResult } from './terminal'

export type SshAuthMethod = 'privateKey' | 'password'

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

export interface SshApi {
  connect: (configId: string) => Promise<TerminalCreateResult>
  deleteConfig: (configId: string) => Promise<void>
  listConfigs: () => Promise<SshServerConfig[]>
  onConfigAdded: (callback: (config: SshServerConfig) => void) => () => void
  onConfigDeleted: (callback: (configId: string) => void) => () => void
  saveConfig: (config: SshServerConfigSaveInput) => Promise<void>
}
