export type SshAuthMethod = 'privateKey' | 'password'

export interface SshServerConfigInput {
  authMethod: SshAuthMethod
  description: string
  host: string
  name: string
  password: string
  port: number
  username: string
}

export interface SshServerConfig extends SshServerConfigInput {
  id: string
}

export interface SshApi {
  closeConfigWindow: () => Promise<void>
  listConfigs: () => Promise<SshServerConfig[]>
  onConfigAdded: (callback: (config: SshServerConfig) => void) => () => void
  openConfigWindow: () => Promise<void>
  saveConfig: (config: SshServerConfigInput) => Promise<void>
}
