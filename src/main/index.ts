import { app, dialog, shell, screen, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, delimiter, dirname, join, parse } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, type IPty } from 'node-pty'
import SftpClient from 'ssh2-sftp-client'
import type { ConnectConfig } from 'ssh2'
import icon from '../../resources/icon.png?asset'
import type {
  AppSettings,
  AppStartupMode,
  QuickCommand,
  SettingsExportResult,
  SettingsImportResult,
  TerminalCursorStyle
} from '../shared/settings'
import type { RestorableTabState, SessionSnapshot, SessionTabSnapshot } from '../shared/session'
import type { LocalTextFile, ShellPickPathsOptions } from '../shared/shell'
import {
  normalizeSshServerIcon,
  type SshDownloadProgressEvent,
  type SshKnownHostsRemovalResult,
  type SshRemoteDirectoryEntry,
  type SshRemoteDirectoryListing,
  type SshRemoteTextFile,
  type SshServerConfig,
  type SshServerConfigInput,
  type SshServerConfigSaveInput,
  type SshTransferProgressStatus,
  type SshUploadProgressEvent
} from '../shared/ssh'
import type { TerminalCreateOptions, TerminalCreateResult } from '../shared/terminal'

interface TerminalSession {
  cwdRefreshTimeout: NodeJS.Timeout | null
  lastCwd: string | null
  ownerId: number
  process: IPty
  shellName: string
  trackCwd: boolean
}

interface SftpBrowserSession {
  client: SftpClient
  configId: string
  idleTimeout: NodeJS.Timeout | null
  isConnected: boolean
  isDisposed: boolean
  operationQueue: Promise<void>
  ownerId: number
}

interface TerminalSpawnResult {
  cwd: string
  process: IPty
  shellName: string
  title: string
  trackCwd: boolean
}

interface PersistedMainWindowState {
  bounds: MainWindowBounds
  isMaximized: boolean
}

interface MainWindowBounds {
  height: number
  width: number
  x?: number
  y?: number
}

interface SshUploadPlanFile {
  localPath: string
  remotePath: string
  size: number
}

interface SshDownloadPlanFile {
  localPath: string
  remotePath: string
  size: number
}

interface SshUploadPlan {
  directories: string[]
  files: SshUploadPlanFile[]
  totalBytes: number
}

interface SshDownloadPlan {
  directories: string[]
  files: SshDownloadPlanFile[]
  totalBytes: number
}

const terminals = new Map<number, TerminalSession>()
const ownersWithCleanup = new Set<number>()
const sftpBrowserSessions = new Map<string, SftpBrowserSession>()
const ownersWithSftpBrowserCleanup = new Set<number>()
let nextTerminalId = 1
let persistedSession: SessionSnapshot | null = null
let persistedSettings: AppSettings | null = null
let persistedMainWindowState: PersistedMainWindowState | null = null
let sshServers: SshServerConfig[] = []
const settingsStoreFileName = 'settings.json'
const sessionStoreFileName = 'terminal-session.json'
const mainWindowStateStoreFileName = 'window-state.json'
const sshPasswordEncryptionSecret = 'T3rm!nal_SSH#2026$Vaulfe35dt@91xZ'
const sshPasswordEncryptionPrefix = 'enc-v1'
const sshPasswordEncryptionKey = createHash('sha256').update(sshPasswordEncryptionSecret).digest()
const sshRemoteCwdOscPrefix = '\u001b]633;TerminalRemoteCwd='
const sshConnectTimeoutSeconds = 10
const sshServerAliveIntervalSeconds = 5
const sshServerAliveCountMax = 2
const sftpBrowserSessionIdleTimeoutMs = 60_000
const maxLocalTextFileBytes = 100 * 1024 * 1024
const maxSshRemoteTextFileBytes = 16 * 1024 * 1024
const defaultMainWindowWidth = 1000
const defaultMainWindowHeight = 600
const minMainWindowWidth = 640
const minMainWindowHeight = 480

function ensureNodePtyHelpersExecutable(): void {
  if (process.platform === 'win32') {
    return
  }

  const packageJsonPath = (() => {
    try {
      return require.resolve('node-pty/package.json')
    } catch {
      return null
    }
  })()

  if (!packageJsonPath) {
    return
  }

  const packageRoot = dirname(packageJsonPath)
  const helperCandidates = [
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    )
  ]

  for (const helperPath of helperCandidates) {
    if (!existsSync(helperPath)) {
      continue
    }

    try {
      chmodSync(helperPath, 0o755)
    } catch (error) {
      console.warn(`Failed to chmod node-pty helper: ${helperPath}`, error)
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function getExecutableCandidates(command: string): string[] {
  if (process.platform === 'win32') {
    const extensions =
      parse(command).ext !== ''
        ? ['']
        : (process.env.PATHEXT?.split(';').filter((value) => value !== '') ?? [
            '.exe',
            '.cmd',
            '.bat',
            '.com'
          ])
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'

    return Array.from(
      new Set([
        ...(process.env.PATH ?? '')
          .split(delimiter)
          .filter((entry) => entry !== '')
          .flatMap((entry) => extensions.map((extension) => join(entry, `${command}${extension}`))),
        ...extensions.map((extension) =>
          join(systemRoot, 'System32', 'OpenSSH', `${command}${extension}`)
        )
      ])
    )
  }

  return Array.from(
    new Set([
      ...(process.env.PATH ?? '')
        .split(delimiter)
        .filter((entry) => entry !== '')
        .map((entry) => join(entry, command)),
      `/usr/bin/${command}`,
      `/bin/${command}`,
      `/usr/local/bin/${command}`,
      `/opt/homebrew/bin/${command}`,
      `/opt/local/bin/${command}`
    ])
  )
}

function resolveExecutablePath(command: string): string {
  if (command.includes('/') || command.includes('\\')) {
    if (isExecutableFile(command)) {
      return command
    }

    throw new Error(`Executable not found or not executable: ${command}`)
  }

  const executablePath = getExecutableCandidates(command).find((candidate) =>
    isExecutableFile(candidate)
  )

  if (!executablePath) {
    throw new Error(`Unable to find "${command}" in PATH or standard locations.`)
  }

  return executablePath
}

function getShellCandidates(): string[] {
  if (process.platform === 'win32') {
    return Array.from(
      new Set(
        [process.env.COMSPEC, 'powershell.exe', 'cmd.exe'].filter(
          (candidate): candidate is string => Boolean(candidate)
        )
      )
    )
  }

  return Array.from(
    new Set(
      [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']
        .filter((candidate): candidate is string => Boolean(candidate))
        .filter((candidate) => !candidate.includes('/') || isExecutableFile(candidate))
    )
  )
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function getTerminalCwd(): string {
  const candidates = [app.getPath('home'), process.cwd(), app.getAppPath(), '/']

  for (const candidate of candidates) {
    if (candidate && isDirectory(candidate)) {
      return candidate
    }
  }

  return '/'
}

function formatShellName(shellPath: string): string {
  return basename(shellPath).replace(/\.exe$/i, '') || 'shell'
}

function formatTerminalTitle(cwd: string, shellName: string): string {
  const homePath = app.getPath('home')
  const normalizedCwd = cwd.replaceAll('\\', '/')
  const normalizedHomePath = homePath.replaceAll('\\', '/')
  let pathTitle = normalizedCwd || '~'

  if (normalizedCwd === normalizedHomePath) {
    pathTitle = '~'
  } else if (normalizedCwd.startsWith(`${normalizedHomePath}/`)) {
    pathTitle = `~${normalizedCwd.slice(normalizedHomePath.length)}`
  }

  return `${pathTitle} — ${shellName}`
}

function getProcessCwd(pid: number): string | null {
  if (pid <= 0) {
    return null
  }

  if (process.platform === 'linux') {
    try {
      return execFileSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' }).trim() || null
    } catch {
      return null
    }
  }

  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const cwdLine = output.split('\n').find((line) => line.startsWith('n') && line.length > 1)

      return cwdLine ? cwdLine.slice(1) : null
    } catch {
      return null
    }
  }

  return null
}

function sendTerminalCwd(webContents: WebContents, terminalId: number, cwd: string): void {
  const session = terminals.get(terminalId)

  if (!session) {
    return
  }

  if (!webContents.isDestroyed()) {
    webContents.send('terminal:cwd', {
      terminalId,
      cwd,
      title: formatTerminalTitle(cwd, session.shellName)
    })
  }
}

function refreshTerminalCwd(
  terminalId: number,
  session: TerminalSession,
  webContents: WebContents
): void {
  if (process.platform === 'win32') {
    return
  }

  const nextCwd = getProcessCwd(session.process.pid)

  if (!nextCwd || nextCwd === session.lastCwd) {
    return
  }

  session.lastCwd = nextCwd
  sendTerminalCwd(webContents, terminalId, nextCwd)
}

function queueTerminalCwdRefresh(
  terminalId: number,
  session: TerminalSession,
  webContents: WebContents
): void {
  if (process.platform === 'win32') {
    return
  }

  if (session.cwdRefreshTimeout) {
    clearTimeout(session.cwdRefreshTimeout)
  }

  session.cwdRefreshTimeout = setTimeout(() => {
    session.cwdRefreshTimeout = null
    refreshTerminalCwd(terminalId, session, webContents)
  }, 120)

  session.cwdRefreshTimeout.unref()
}

function startTerminalCwdTracking(
  terminalId: number,
  session: TerminalSession,
  webContents: WebContents,
  initialCwd: string
): void {
  session.lastCwd = initialCwd
  sendTerminalCwd(webContents, terminalId, initialCwd)
}

function stopTerminalCwdTracking(session: TerminalSession): void {
  if (!session.cwdRefreshTimeout) {
    return
  }

  clearTimeout(session.cwdRefreshTimeout)
  session.cwdRefreshTimeout = null
}

function getTerminalEnv(cwd: string, extraEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }

  env.COLORTERM = 'truecolor'
  env.PWD = cwd
  env.TERM = 'xterm-256color'
  env.TERM_PROGRAM = app.getName()

  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      env[key] = value
    }
  }

  return env
}

function spawnTerminalProcess(options?: TerminalCreateOptions): TerminalSpawnResult {
  const cwd =
    options?.cwd && options.cwd.trim() !== '' && isDirectory(options.cwd.trim())
      ? options.cwd.trim()
      : getTerminalCwd()
  const env = getTerminalEnv(cwd, options?.env)

  if (options?.command) {
    const commandPath = resolveExecutablePath(options.command)
    const shellName = formatShellName(commandPath)

    try {
      return {
        cwd,
        process: spawn(commandPath, options.args ?? [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd,
          env
        }),
        shellName,
        title: options.title?.trim() || shellName,
        trackCwd: options.trackCwd ?? false
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Unable to start "${commandPath}" in "${cwd}". ${message}`)
    }
  }

  const failures: string[] = []

  for (const shellPath of getShellCandidates()) {
    try {
      const shellName = formatShellName(shellPath)

      return {
        cwd,
        process: spawn(shellPath, [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd,
          env
        }),
        shellName,
        title: formatTerminalTitle(cwd, shellName),
        trackCwd: options?.trackCwd ?? true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${shellPath}: ${message}`)
    }
  }

  throw new Error(`Unable to start a terminal shell in "${cwd}". ${failures.join(' | ')}`)
}

function destroyTerminal(terminalId: number): void {
  const session = terminals.get(terminalId)

  if (!session) {
    return
  }

  terminals.delete(terminalId)
  stopTerminalCwdTracking(session)

  try {
    session.process.kill()
  } catch (error) {
    console.error(`Failed to stop terminal ${terminalId}`, error)
  }
}

function destroyOwnerTerminals(ownerId: number): void {
  for (const [terminalId, session] of terminals) {
    if (session.ownerId === ownerId) {
      destroyTerminal(terminalId)
    }
  }

  ownersWithCleanup.delete(ownerId)
}

function registerOwnerCleanup(webContents: WebContents): void {
  if (ownersWithCleanup.has(webContents.id)) {
    return
  }

  ownersWithCleanup.add(webContents.id)
  webContents.once('destroyed', () => destroyOwnerTerminals(webContents.id))
}

function createSftpBrowserClient(configId: string): SftpClient {
  return new SftpClient(`terminal-list-directory:${configId}`)
}

function getSftpBrowserSessionKey(ownerId: number, configId: string): string {
  return `${ownerId}:${configId}`
}

function clearSftpBrowserSessionIdleTimeout(session: SftpBrowserSession): void {
  if (!session.idleTimeout) {
    return
  }

  clearTimeout(session.idleTimeout)
  session.idleTimeout = null
}

async function resetSftpBrowserSessionClient(session: SftpBrowserSession): Promise<void> {
  const currentClient = session.client
  session.client = createSftpBrowserClient(session.configId)
  session.isConnected = false

  await currentClient.end().catch(() => false)
}

async function destroySftpBrowserSession(
  sessionKey: string,
  session: SftpBrowserSession | undefined = sftpBrowserSessions.get(sessionKey)
): Promise<void> {
  if (!session || session.isDisposed) {
    return
  }

  session.isDisposed = true
  clearSftpBrowserSessionIdleTimeout(session)

  if (sftpBrowserSessions.get(sessionKey) === session) {
    sftpBrowserSessions.delete(sessionKey)
  }

  await session.operationQueue.catch(() => undefined)
  await resetSftpBrowserSessionClient(session)
}

function destroyOwnerSftpBrowserSessions(ownerId: number): void {
  for (const [sessionKey, session] of Array.from(sftpBrowserSessions.entries())) {
    if (session.ownerId === ownerId) {
      void destroySftpBrowserSession(sessionKey, session)
    }
  }

  ownersWithSftpBrowserCleanup.delete(ownerId)
}

function destroyAllSftpBrowserSessions(): void {
  for (const [sessionKey, session] of Array.from(sftpBrowserSessions.entries())) {
    void destroySftpBrowserSession(sessionKey, session)
  }
}

function registerSftpBrowserOwnerCleanup(webContents: WebContents): void {
  if (ownersWithSftpBrowserCleanup.has(webContents.id)) {
    return
  }

  ownersWithSftpBrowserCleanup.add(webContents.id)
  webContents.once('destroyed', () => destroyOwnerSftpBrowserSessions(webContents.id))
}

function scheduleSftpBrowserSessionIdleTimeout(
  sessionKey: string,
  session: SftpBrowserSession
): void {
  clearSftpBrowserSessionIdleTimeout(session)
  session.idleTimeout = setTimeout(() => {
    void destroySftpBrowserSession(sessionKey, session)
  }, sftpBrowserSessionIdleTimeoutMs)
  session.idleTimeout.unref()
}

function getOrCreateSftpBrowserSession(
  webContents: WebContents,
  configId: string
): [string, SftpBrowserSession] {
  registerSftpBrowserOwnerCleanup(webContents)

  const sessionKey = getSftpBrowserSessionKey(webContents.id, configId)
  const existingSession = sftpBrowserSessions.get(sessionKey)

  if (existingSession && !existingSession.isDisposed) {
    return [sessionKey, existingSession]
  }

  const session: SftpBrowserSession = {
    client: createSftpBrowserClient(configId),
    configId,
    idleTimeout: null,
    isConnected: false,
    isDisposed: false,
    operationQueue: Promise.resolve(),
    ownerId: webContents.id
  }

  sftpBrowserSessions.set(sessionKey, session)
  return [sessionKey, session]
}

function queueSftpBrowserSessionOperation<T>(
  sessionKey: string,
  session: SftpBrowserSession,
  operation: () => Promise<T>
): Promise<T> {
  const queuedOperation = session.operationQueue
    .catch(() => undefined)
    .then(async () => {
      if (session.isDisposed) {
        throw new Error('Remote browser session is no longer available.')
      }

      clearSftpBrowserSessionIdleTimeout(session)

      try {
        return await operation()
      } finally {
        if (!session.isDisposed) {
          scheduleSftpBrowserSessionIdleTimeout(sessionKey, session)
        }
      }
    })

  session.operationQueue = queuedOperation.then(
    () => {},
    () => {}
  )

  return queuedOperation
}

async function connectSftpBrowserSession(session: SftpBrowserSession): Promise<SftpClient> {
  if (session.isDisposed) {
    throw new Error('Remote browser session is no longer available.')
  }

  if (session.isConnected) {
    return session.client
  }

  const { config, password } = resolveSshServerConnection(session.configId)

  try {
    await session.client.connect(buildSftpConnectOptions(config, password))
    session.isConnected = true
    return session.client
  } catch (error) {
    await resetSftpBrowserSessionClient(session)
    throw error
  }
}

function isRecoverableSftpBrowserSessionError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()

  return [
    'not connected',
    'no sftp connection',
    'connection ended',
    'connection lost',
    'socket closed',
    'channel is not open',
    'session is closed',
    'client is closed'
  ].some((token) => message.includes(token))
}

async function runSftpBrowserSessionOperation<T>(
  webContents: WebContents,
  configId: string,
  operation: (sftpClient: SftpClient) => Promise<T>
): Promise<T> {
  const [sessionKey, session] = getOrCreateSftpBrowserSession(webContents, configId)

  return queueSftpBrowserSessionOperation(sessionKey, session, async () => {
    const sftpClient = await connectSftpBrowserSession(session)

    try {
      return await operation(sftpClient)
    } catch (error) {
      if (!isRecoverableSftpBrowserSessionError(error) || session.isDisposed) {
        throw error
      }

      await resetSftpBrowserSessionClient(session)
      return operation(await connectSftpBrowserSession(session))
    }
  })
}

function invalidateSftpBrowserSessionsForConfig(configId: string): void {
  for (const [sessionKey, session] of Array.from(sftpBrowserSessions.entries())) {
    if (session.configId === configId) {
      void destroySftpBrowserSession(sessionKey, session)
    }
  }
}

function createTerminal(
  webContents: WebContents,
  options?: TerminalCreateOptions
): TerminalCreateResult {
  registerOwnerCleanup(webContents)

  const terminalId = nextTerminalId++
  const {
    cwd,
    process: terminalProcess,
    shellName,
    title,
    trackCwd
  } = spawnTerminalProcess(options)
  const session: TerminalSession = {
    cwdRefreshTimeout: null,
    lastCwd: null,
    ownerId: webContents.id,
    process: terminalProcess,
    shellName,
    trackCwd
  }

  terminals.set(terminalId, session)

  if (trackCwd) {
    startTerminalCwdTracking(terminalId, session, webContents, cwd)
  }

  terminalProcess.onData((data) => {
    if (!webContents.isDestroyed()) {
      webContents.send('terminal:data', { terminalId, data })
    }

    if (session.trackCwd) {
      queueTerminalCwdRefresh(terminalId, session, webContents)
    }
  })

  terminalProcess.onExit(({ exitCode, signal }) => {
    stopTerminalCwdTracking(session)
    terminals.delete(terminalId)

    if (!webContents.isDestroyed()) {
      webContents.send('terminal:exit', { terminalId, exitCode, signal })
    }
  })

  return {
    terminalId,
    title
  }
}

function isSshAuthMethod(value: unknown): value is SshServerConfig['authMethod'] {
  return value === 'privateKey' || value === 'password'
}

function stripSshServerPassword(config: SshServerConfig): SshServerConfig {
  return {
    ...config,
    password: ''
  }
}

function parsePersistedSshServers(value: unknown): SshServerConfig[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  return value
    .map((config) => parsePersistedSshServerConfig(config))
    .filter((config): config is SshServerConfig => config !== null)
}

function parsePersistedSshServerConfig(value: unknown): SshServerConfig | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const portValue =
    typeof record.port === 'number'
      ? record.port
      : typeof record.port === 'string' && record.port.trim() !== ''
        ? Number(record.port)
        : NaN

  if (
    typeof record.id !== 'string' ||
    typeof record.host !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.username !== 'string' ||
    typeof record.description !== 'string' ||
    !Number.isFinite(portValue) ||
    !isSshAuthMethod(record.authMethod)
  ) {
    return null
  }

  return {
    id: record.id,
    authMethod: record.authMethod,
    defaultRemoteStartPath:
      typeof record.defaultRemoteStartPath === 'string' ? record.defaultRemoteStartPath.trim() : '',
    description: record.description.trim(),
    host: record.host.trim(),
    icon: normalizeSshServerIcon(record.icon),
    name: record.name.trim(),
    password: typeof record.password === 'string' ? record.password : '',
    privateKeyPath: typeof record.privateKeyPath === 'string' ? record.privateKeyPath.trim() : '',
    port: Math.max(1, Math.floor(portValue)),
    username: record.username.trim()
  }
}

function getSettingsStorePath(): string {
  return join(app.getPath('userData'), settingsStoreFileName)
}

function getSessionStorePath(): string {
  return join(app.getPath('userData'), sessionStoreFileName)
}

function getMainWindowStateStorePath(): string {
  return join(app.getPath('userData'), mainWindowStateStoreFileName)
}

function getSshAskpassHelperPath(): string {
  return join(
    app.getPath('userData'),
    process.platform === 'win32' ? 'ssh-askpass.cmd' : 'ssh-askpass.sh'
  )
}

function encryptSshPassword(password: string): string {
  const initializationVector = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sshPasswordEncryptionKey, initializationVector)
  const encryptedBuffer = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [
    sshPasswordEncryptionPrefix,
    initializationVector.toString('base64'),
    authTag.toString('base64'),
    encryptedBuffer.toString('base64')
  ].join(':')
}

function decryptSshPassword(password: string): string | null {
  if (password === '') {
    return null
  }

  if (!password.startsWith(`${sshPasswordEncryptionPrefix}:`)) {
    return password
  }

  const [prefix, initializationVectorBase64, authTagBase64, encryptedBase64, ...rest] =
    password.split(':')

  if (
    prefix !== sshPasswordEncryptionPrefix ||
    !initializationVectorBase64 ||
    !authTagBase64 ||
    !encryptedBase64 ||
    rest.length > 0
  ) {
    console.warn('Unexpected SSH password format in persisted settings')
    return null
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sshPasswordEncryptionKey,
      Buffer.from(initializationVectorBase64, 'base64')
    )
    decipher.setAuthTag(Buffer.from(authTagBase64, 'base64'))

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedBase64, 'base64')),
      decipher.final()
    ]).toString('utf8')
  } catch (error) {
    console.warn('Failed to decrypt SSH password from persisted settings', error)
    return null
  }
}

function ensureSshAskpassHelper(): string | null {
  if (process.platform === 'win32') {
    return null
  }

  const helperPath = getSshAskpassHelperPath()
  const helperContents = `#!/bin/sh
if [ -z "\${TERMINAL_SSH_PASSWORD+x}" ]; then
  exit 1
fi

printf '%s\\n' "$TERMINAL_SSH_PASSWORD"
`

  try {
    if (!existsSync(helperPath) || readFileSync(helperPath, 'utf8') !== helperContents) {
      writeFileSync(helperPath, helperContents, 'utf8')
    }

    chmodSync(helperPath, 0o700)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to prepare SSH askpass helper: ${message}`)
  }

  return helperPath
}

function getSshCommandEnv(
  password: string | null,
  requireNonInteractiveAuth = false
): Record<string, string> | undefined {
  if (!password) {
    return undefined
  }

  const askpassHelperPath = ensureSshAskpassHelper()

  if (!askpassHelperPath) {
    if (requireNonInteractiveAuth) {
      throw new Error('Password-based remote browsing requires SSH askpass support.')
    }

    return undefined
  }

  return {
    DISPLAY: process.env.DISPLAY || 'terminal:0',
    SSH_ASKPASS: askpassHelperPath,
    SSH_ASKPASS_REQUIRE: 'force',
    TERMINAL_SSH_PASSWORD: password
  }
}

function buildSshBaseArgs(config: SshServerConfig): string[] {
  const args: string[] = []

  if (config.authMethod === 'password') {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PubkeyAuthentication=no'
    )
  }

  if (config.authMethod === 'privateKey' && config.privateKeyPath !== '') {
    args.push('-i', config.privateKeyPath, '-o', 'IdentitiesOnly=yes')
  }

  args.push(
    '-o',
    `ConnectTimeout=${sshConnectTimeoutSeconds}`,
    '-o',
    `ServerAliveInterval=${sshServerAliveIntervalSeconds}`,
    '-o',
    `ServerAliveCountMax=${sshServerAliveCountMax}`
  )
  args.push('-p', String(config.port))

  return args
}

function buildScpBaseArgs(config: SshServerConfig): string[] {
  const args: string[] = []

  if (config.authMethod === 'password') {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PubkeyAuthentication=no'
    )
  }

  if (config.authMethod === 'privateKey' && config.privateKeyPath !== '') {
    args.push('-i', config.privateKeyPath, '-o', 'IdentitiesOnly=yes')
  }

  args.push(
    '-o',
    `ConnectTimeout=${sshConnectTimeoutSeconds}`,
    '-o',
    `ServerAliveInterval=${sshServerAliveIntervalSeconds}`,
    '-o',
    `ServerAliveCountMax=${sshServerAliveCountMax}`
  )
  args.push('-P', String(config.port))

  return args
}

function trimTrailingPathSeparators(value: string): string {
  const trimmedValue = value.replace(/[\\/]+$/, '')
  return trimmedValue === '' ? value : trimmedValue
}

function normalizeRemoteDirectoryPath(path: string): string {
  const trimmedPath = path.trim()

  if (trimmedPath === '' || trimmedPath === '/') {
    return '/'
  }

  return trimmedPath.replace(/\/+$/, '') || '/'
}

function joinRemoteUploadPath(basePath: string, name: string): string {
  const normalizedBasePath = normalizeRemoteDirectoryPath(basePath)
  return normalizedBasePath === '/' ? `/${name}` : `${normalizedBasePath}/${name}`
}

function getDefaultSshPrivateKeyPath(): string | null {
  const sshDirectoryPath = join(app.getPath('home'), '.ssh')
  const privateKeyCandidates = [
    'id_ed25519',
    'id_ecdsa',
    'id_rsa',
    'id_dsa',
    'id_xmss',
    'id_ecdsa_sk',
    'id_ed25519_sk'
  ]

  for (const fileName of privateKeyCandidates) {
    const candidatePath = join(sshDirectoryPath, fileName)

    if (existsSync(candidatePath)) {
      return candidatePath
    }
  }

  return null
}

function getKnownHostsPath(): string {
  return join(app.getPath('home'), '.ssh', 'known_hosts')
}

function normalizeKnownHostsHost(host: string): string {
  const trimmedHost = host.trim()
  const bracketedHostMatch = trimmedHost.match(/^\[([^\]]+)\](?::\d+)?$/)
  return bracketedHostMatch ? bracketedHostMatch[1] : trimmedHost
}

function getKnownHostsTargets(host: string, port: number): string[] {
  const normalizedHost = normalizeKnownHostsHost(host)

  if (normalizedHost === '') {
    return []
  }

  const normalizedPort = Number.isFinite(port) ? Math.max(1, Math.floor(port)) : 22

  return Array.from(new Set([normalizedHost, `[${normalizedHost}]:${normalizedPort}`]))
}

function knownHostsEntryExists(
  sshKeygenPath: string,
  knownHostsPath: string,
  host: string
): boolean {
  try {
    execFileSync(sshKeygenPath, ['-F', host, '-f', knownHostsPath], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

function removeKnownHostsEntries(host: string, port: number): SshKnownHostsRemovalResult {
  const targets = getKnownHostsTargets(host, port)

  if (targets.length === 0) {
    throw new Error('Host is required.')
  }

  const knownHostsPath = getKnownHostsPath()

  if (!existsSync(knownHostsPath)) {
    return { removedHosts: [] }
  }

  const sshKeygenPath = resolveExecutablePath('ssh-keygen')
  const backupPath = `${knownHostsPath}.old`
  const removedHosts: string[] = []

  for (const target of targets) {
    if (!knownHostsEntryExists(sshKeygenPath, knownHostsPath, target)) {
      continue
    }

    const backupExistedBeforeRemoval = existsSync(backupPath)

    try {
      execFileSync(sshKeygenPath, ['-R', target, '-f', knownHostsPath], {
        stdio: 'ignore'
      })
      removedHosts.push(target)

      if (!backupExistedBeforeRemoval && existsSync(backupPath)) {
        unlinkSync(backupPath)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Unable to remove known_hosts entries for ${target}: ${message}`)
    }
  }

  return { removedHosts }
}

function buildSftpConnectOptions(config: SshServerConfig, password: string | null): ConnectConfig {
  const connectOptions: ConnectConfig = {
    host: config.host,
    port: config.port,
    readyTimeout: 20_000,
    username: config.username
  }

  if (config.authMethod === 'password') {
    if (!password) {
      throw new Error('Password-based SSH connection requires a password.')
    }

    return {
      ...connectOptions,
      password
    }
  }

  const privateKeyPath = config.privateKeyPath.trim() || getDefaultSshPrivateKeyPath()

  if (privateKeyPath) {
    return {
      ...connectOptions,
      privateKey: readFileSync(privateKeyPath)
    }
  }

  if (process.env['SSH_AUTH_SOCK']) {
    return {
      ...connectOptions,
      agent: process.env['SSH_AUTH_SOCK']
    }
  }

  throw new Error('No SSH private key is available for this SSH connection.')
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function isProbablyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true
  }

  const inspectedLength = Math.min(buffer.length, 8192)
  let suspiciousByteCount = 0

  for (let index = 0; index < inspectedLength; index += 1) {
    const value = buffer[index]

    if (value === 0) {
      return false
    }

    if (value === 9 || value === 10 || value === 13) {
      continue
    }

    if ((value >= 32 && value <= 126) || value >= 128) {
      continue
    }

    suspiciousByteCount += 1
  }

  return suspiciousByteCount / inspectedLength < 0.1
}

function formatSftpRightsSegment(value: string): string {
  const normalizedValue = typeof value === 'string' ? value : ''
  return ['r', 'w', 'x'].map((token) => (normalizedValue.includes(token) ? token : '-')).join('')
}

function mapSftpFileTypeToRemoteEntryType(type: string): SshRemoteDirectoryEntry['type'] {
  if (type === 'd') {
    return 'directory'
  }

  if (type === '-') {
    return 'file'
  }

  if (type === 'l') {
    return 'symlink'
  }

  return 'other'
}

function mapSftpFileInfoToRemoteEntry(
  fileInfo: Awaited<ReturnType<SftpClient['list']>>[number]
): SshRemoteDirectoryEntry {
  const type = mapSftpFileTypeToRemoteEntryType(fileInfo.type)
  const permissions =
    fileInfo.rights &&
    typeof fileInfo.rights.user === 'string' &&
    typeof fileInfo.rights.group === 'string' &&
    typeof fileInfo.rights.other === 'string'
      ? `${formatSftpRightsSegment(fileInfo.rights.user)}${formatSftpRightsSegment(fileInfo.rights.group)}${formatSftpRightsSegment(fileInfo.rights.other)}`
      : null

  return {
    isDirectory: type === 'directory',
    modifiedAt: Number.isFinite(fileInfo.modifyTime) ? fileInfo.modifyTime : null,
    name: fileInfo.name,
    permissions,
    size: type === 'directory' ? null : Number.isFinite(fileInfo.size) ? fileInfo.size : null,
    type
  }
}

async function resolveSftpDirectoryPath(sftpClient: SftpClient, path?: string): Promise<string> {
  const normalizedPath = path?.trim()

  if (!normalizedPath) {
    return sftpClient.cwd()
  }

  const entryType = await sftpClient.exists(normalizedPath)

  if (!entryType) {
    throw new Error('Remote folder not found.')
  }

  if (entryType !== 'd') {
    const remoteStats = await sftpClient.stat(normalizedPath)

    if (!remoteStats.isDirectory) {
      throw new Error('Remote path is not a folder.')
    }
  }

  return sftpClient.realPath(normalizedPath)
}

function collectSshUploadPlanEntries(
  localPath: string,
  remotePath: string,
  directories: Set<string>,
  files: SshUploadPlanFile[]
): void {
  const stats = statSync(localPath)

  if (stats.isDirectory()) {
    directories.add(remotePath)

    for (const childName of readdirSync(localPath).sort((left, right) =>
      left.localeCompare(right)
    )) {
      collectSshUploadPlanEntries(
        join(localPath, childName),
        joinRemoteUploadPath(remotePath, childName),
        directories,
        files
      )
    }

    return
  }

  if (stats.isFile()) {
    files.push({
      localPath,
      remotePath,
      size: stats.size
    })
    return
  }

  throw new Error(`Only files and folders can be uploaded: ${localPath}`)
}

function collectSshUploadPlan(localPaths: string[], targetPath: string): SshUploadPlan {
  const directories = new Set<string>()
  const files: SshUploadPlanFile[] = []

  for (const localPath of localPaths) {
    const normalizedLocalPath = trimTrailingPathSeparators(localPath)
    const remoteRootPath = joinRemoteUploadPath(
      targetPath,
      basename(normalizedLocalPath) || basename(localPath)
    )

    collectSshUploadPlanEntries(normalizedLocalPath, remoteRootPath, directories, files)
  }

  return {
    directories: Array.from(directories).sort((left, right) => left.length - right.length),
    files,
    totalBytes: files.reduce((totalSize, file) => totalSize + file.size, 0)
  }
}

async function collectSshDownloadPlanEntries(
  sftpClient: SftpClient,
  remotePath: string,
  localPath: string,
  directories: Set<string>,
  files: SshDownloadPlanFile[],
  fileInfo?: Awaited<ReturnType<SftpClient['list']>>[number]
): Promise<void> {
  const entryType = fileInfo?.type ?? (await sftpClient.exists(remotePath))

  if (!entryType) {
    throw new Error(`Remote path not found: ${remotePath}`)
  }

  if (entryType === 'd') {
    directories.add(localPath)
    const listing = await sftpClient.list(remotePath)

    listing.sort((left, right) => left.name.localeCompare(right.name))

    for (const childEntry of listing) {
      await collectSshDownloadPlanEntries(
        sftpClient,
        joinRemoteUploadPath(remotePath, childEntry.name),
        join(localPath, childEntry.name),
        directories,
        files,
        childEntry
      )
    }

    return
  }

  const remoteStats = await sftpClient.stat(remotePath)

  if (remoteStats.isDirectory) {
    directories.add(localPath)
    const listing = await sftpClient.list(remotePath)

    listing.sort((left, right) => left.name.localeCompare(right.name))

    for (const childEntry of listing) {
      await collectSshDownloadPlanEntries(
        sftpClient,
        joinRemoteUploadPath(remotePath, childEntry.name),
        join(localPath, childEntry.name),
        directories,
        files,
        childEntry
      )
    }

    return
  }

  files.push({
    localPath,
    remotePath,
    size: remoteStats.size
  })
}

async function collectSshDownloadPlan(
  sftpClient: SftpClient,
  remotePath: string,
  localPath: string
): Promise<SshDownloadPlan> {
  const directories = new Set<string>()
  const files: SshDownloadPlanFile[] = []

  await collectSshDownloadPlanEntries(sftpClient, remotePath, localPath, directories, files)

  return {
    directories: Array.from(directories).sort((left, right) => left.length - right.length),
    files,
    totalBytes: files.reduce((totalSize, file) => totalSize + file.size, 0)
  }
}

function emitSshUploadProgress(webContents: WebContents, payload: SshUploadProgressEvent): void {
  if (!webContents.isDestroyed()) {
    webContents.send('ssh:upload-progress', payload)
  }
}

function emitSshDownloadProgress(
  webContents: WebContents,
  payload: SshDownloadProgressEvent
): void {
  if (!webContents.isDestroyed()) {
    webContents.send('ssh:download-progress', payload)
  }
}

function createSshUploadProgressEmitter(
  webContents: WebContents,
  uploadId: string,
  targetPath: string,
  totalBytes: number
): (
  status: SshTransferProgressStatus,
  transferredBytes: number,
  currentPath?: string | null
) => void {
  let lastPercent = -1
  let lastStatus: SshTransferProgressStatus | null = null
  let lastPath: string | null = null

  return (status, transferredBytes, currentPath = null) => {
    const normalizedTransferredBytes =
      totalBytes <= 0 ? 0 : Math.min(Math.max(0, transferredBytes), totalBytes)
    const percent =
      totalBytes <= 0
        ? status === 'completed'
          ? 100
          : 0
        : Math.round((normalizedTransferredBytes / totalBytes) * 100)

    if (status === lastStatus && percent === lastPercent && currentPath === lastPath) {
      return
    }

    lastStatus = status
    lastPercent = percent
    lastPath = currentPath

    emitSshUploadProgress(webContents, {
      currentPath,
      percent,
      status,
      targetPath,
      totalBytes,
      transferredBytes: status === 'completed' ? totalBytes : normalizedTransferredBytes,
      uploadId
    })
  }
}

function createSshDownloadProgressEmitter(
  webContents: WebContents,
  downloadId: string,
  sourcePath: string,
  targetPath: string,
  totalBytes: number
): (
  status: SshTransferProgressStatus,
  transferredBytes: number,
  currentPath?: string | null
) => void {
  let lastPercent = -1
  let lastStatus: SshTransferProgressStatus | null = null
  let lastPath: string | null = null

  return (status, transferredBytes, currentPath = null) => {
    const normalizedTransferredBytes =
      totalBytes <= 0 ? 0 : Math.min(Math.max(0, transferredBytes), totalBytes)
    const percent =
      totalBytes <= 0
        ? status === 'completed'
          ? 100
          : 0
        : Math.round((normalizedTransferredBytes / totalBytes) * 100)

    if (status === lastStatus && percent === lastPercent && currentPath === lastPath) {
      return
    }

    lastStatus = status
    lastPercent = percent
    lastPath = currentPath

    emitSshDownloadProgress(webContents, {
      currentPath,
      downloadId,
      percent,
      sourcePath,
      status,
      targetPath,
      totalBytes,
      transferredBytes: status === 'completed' ? totalBytes : normalizedTransferredBytes
    })
  }
}

function buildInteractiveSshRemoteCommand(cwd?: string): string {
  const scriptLines = [
    'shell_path=${SHELL:-/bin/sh}',
    'shell_name=${shell_path##*/}',
    `emit_cwd() { printf '\\033]633;TerminalRemoteCwd=%s\\007' "$PWD"; }`,
    cwd?.trim() ? `cd -- ${quoteForPosixShell(cwd.trim())} 2>/dev/null || :` : '',
    'case "$shell_name" in',
    '  zsh)',
    '    _terminal_zdotdir="$(mktemp -d "${TMPDIR:-/tmp}/terminal-zsh.XXXXXX" 2>/dev/null)" || _terminal_zdotdir=""',
    '    if [ -n "$_terminal_zdotdir" ]; then',
    `      cat >"$_terminal_zdotdir/.zshenv" <<'EOF'`,
    '[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"',
    'EOF',
    `      cat >"$_terminal_zdotdir/.zprofile" <<'EOF'`,
    '[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"',
    'EOF',
    `      cat >"$_terminal_zdotdir/.zshrc" <<'EOF'`,
    '[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
    `function _terminal_emit_remote_cwd() { printf '${sshRemoteCwdOscPrefix}%s\\007' "$PWD"; }`,
    'autoload -Uz add-zsh-hook 2>/dev/null || true',
    'if whence add-zsh-hook >/dev/null 2>&1; then',
    '  add-zsh-hook precmd _terminal_emit_remote_cwd',
    'elif (( ${precmd_functions[(I)_terminal_emit_remote_cwd]} == 0 )); then',
    '  precmd_functions+=(_terminal_emit_remote_cwd)',
    'fi',
    '_terminal_emit_remote_cwd',
    'EOF',
    `      cat >"$_terminal_zdotdir/.zlogin" <<'EOF'`,
    '[[ -f "$HOME/.zlogin" ]] && source "$HOME/.zlogin"',
    'EOF',
    `      cat >"$_terminal_zdotdir/.zlogout" <<'EOF'`,
    'command rm -rf -- "$ZDOTDIR" 2>/dev/null || true',
    'EOF',
    '      exec env ZDOTDIR="$_terminal_zdotdir" "$shell_path" -il',
    '    fi',
    '    ;;',
    'esac',
    'if [ "$shell_name" = "bash" ]; then',
    `  _terminal_prompt_command='printf '\\''${sshRemoteCwdOscPrefix}%s\\007'\\'' "$PWD"'`,
    '  export PROMPT_COMMAND="${_terminal_prompt_command}${PROMPT_COMMAND:+;${PROMPT_COMMAND}}"',
    'fi',
    'emit_cwd',
    'exec "$shell_path" -il'
  ].filter((line) => line !== '')

  return `sh -lc ${quoteForPosixShell(scriptLines.join('\n'))}`
}

function buildSshCreatePathCommand(path: string, isDirectory: boolean): string {
  const existingEntryMessage = isDirectory
    ? 'Remote folder already exists.'
    : 'Remote file already exists.'
  const scriptLines = [
    'set -e',
    `if [ -e ${quoteForPosixShell(path)} ]; then printf '%s\\n' ${quoteForPosixShell(existingEntryMessage)} >&2; exit 1; fi`,
    isDirectory ? `mkdir -- ${quoteForPosixShell(path)}` : `: > ${quoteForPosixShell(path)}`
  ]

  return `sh -lc ${quoteForPosixShell(scriptLines.join('\n'))}`
}

function buildSshDeletePathCommand(path: string, isDirectory: boolean): string {
  const scriptLines = [
    'set -e',
    `${isDirectory ? 'rm -rf' : 'rm -f'} -- ${quoteForPosixShell(path)}`
  ]

  return `sh -lc ${quoteForPosixShell(scriptLines.join('\n'))}`
}

function buildSshRenamePathCommand(path: string, nextPath: string): string {
  const scriptLines = [
    'set -e',
    `mv -- ${quoteForPosixShell(path)} ${quoteForPosixShell(nextPath)}`
  ]

  return `sh -lc ${quoteForPosixShell(scriptLines.join('\n'))}`
}

function runSshCommand(
  config: SshServerConfig,
  password: string | null,
  remoteCommand: string
): Promise<string> {
  const sshPath = resolveExecutablePath('ssh')
  const sshEnv = getSshCommandEnv(password, true)
  const commandEnv = sshEnv ? { ...process.env, ...sshEnv } : process.env

  return new Promise((resolve, reject) => {
    execFile(
      sshPath,
      [...buildSshBaseArgs(config), `${config.username}@${config.host}`, remoteCommand],
      {
        encoding: 'utf8',
        env: commandEnv
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }

        const message = stderr.trim() || stdout.trim() || error.message
        reject(new Error(message))
      }
    )
  })
}

function runScpCommand(
  config: SshServerConfig,
  password: string | null,
  remotePath: string,
  localPath: string,
  isDirectory: boolean
): Promise<void> {
  const scpPath = resolveExecutablePath('scp')
  const scpEnv = getSshCommandEnv(password, true)
  const commandEnv = scpEnv ? { ...process.env, ...scpEnv } : process.env
  const args = buildScpBaseArgs(config)

  if (isDirectory) {
    args.push('-r')
  }

  args.push(`${config.username}@${config.host}:${remotePath}`, localPath)

  return new Promise((resolve, reject) => {
    execFile(
      scpPath,
      args,
      {
        encoding: 'utf8',
        env: commandEnv
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }

        const message = stderr.trim() || stdout.trim() || error.message
        reject(new Error(message))
      }
    )
  })
}

function runScpUploadCommand(
  config: SshServerConfig,
  password: string | null,
  localPath: string,
  remotePath: string
): Promise<void> {
  const scpPath = resolveExecutablePath('scp')
  const scpEnv = getSshCommandEnv(password, true)
  const commandEnv = scpEnv ? { ...process.env, ...scpEnv } : process.env
  const args = buildScpBaseArgs(config)

  args.push(localPath, `${config.username}@${config.host}:${remotePath}`)

  return new Promise((resolve, reject) => {
    execFile(
      scpPath,
      args,
      {
        encoding: 'utf8',
        env: commandEnv
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }

        const message = stderr.trim() || stdout.trim() || error.message
        reject(new Error(message))
      }
    )
  })
}

async function runSftpUploadCommand(
  webContents: WebContents,
  config: SshServerConfig,
  password: string | null,
  localPaths: string[],
  remotePath: string
): Promise<void> {
  const normalizedRemotePath = normalizeRemoteDirectoryPath(remotePath)
  const uploadPlan = collectSshUploadPlan(localPaths, normalizedRemotePath)
  const uploadId = randomUUID()
  const emitProgress = createSshUploadProgressEmitter(
    webContents,
    uploadId,
    normalizedRemotePath,
    uploadPlan.totalBytes
  )
  const sftpClient = new SftpClient('terminal-upload')
  let transferredBytes = 0

  emitProgress('running', 0)

  try {
    await sftpClient.connect(buildSftpConnectOptions(config, password))

    const targetPathType = await sftpClient.exists(normalizedRemotePath)

    if (targetPathType !== 'd') {
      throw new Error('Remote target folder was not found.')
    }

    for (const directoryPath of uploadPlan.directories) {
      await sftpClient.mkdir(directoryPath, true)
    }

    for (const file of uploadPlan.files) {
      emitProgress('running', transferredBytes, file.localPath)

      await sftpClient.fastPut(file.localPath, file.remotePath, {
        step: (totalTransferred, _chunk, total) => {
          const fileTotalBytes = total > 0 ? total : file.size
          const nextTransferredBytes =
            transferredBytes + Math.min(file.size, Math.min(fileTotalBytes, totalTransferred))

          emitProgress('running', nextTransferredBytes, file.localPath)
        }
      })

      transferredBytes += file.size
      emitProgress('running', transferredBytes, file.localPath)
    }

    emitProgress('completed', uploadPlan.totalBytes, uploadPlan.files.at(-1)?.localPath ?? null)
  } catch (error) {
    emitProgress('failed', transferredBytes)
    throw error
  } finally {
    await sftpClient.end().catch(() => false)
  }
}

async function runSftpDownloadCommand(
  webContents: WebContents,
  config: SshServerConfig,
  password: string | null,
  remotePath: string,
  localPath: string
): Promise<void> {
  const sftpClient = new SftpClient('terminal-download')
  const downloadId = randomUUID()
  let transferredBytes = 0
  let totalBytes = 0
  let emitProgress:
    | ((
        status: SshTransferProgressStatus,
        transferredBytes: number,
        currentPath?: string | null
      ) => void)
    | null = null

  try {
    await sftpClient.connect(buildSftpConnectOptions(config, password))

    const remoteStats = await sftpClient.stat(remotePath)
    const nextEmitProgress = createSshDownloadProgressEmitter(
      webContents,
      downloadId,
      remotePath,
      localPath,
      0
    )
    emitProgress = nextEmitProgress

    if (remoteStats.isDirectory) {
      const downloadPlan = await collectSshDownloadPlan(sftpClient, remotePath, localPath)
      totalBytes = downloadPlan.totalBytes
      emitProgress = createSshDownloadProgressEmitter(
        webContents,
        downloadId,
        remotePath,
        localPath,
        totalBytes
      )

      emitProgress('running', 0, downloadPlan.files[0]?.remotePath ?? remotePath)

      for (const directoryPath of downloadPlan.directories) {
        mkdirSync(directoryPath, { recursive: true })
      }

      for (const file of downloadPlan.files) {
        emitProgress('running', transferredBytes, file.remotePath)

        await sftpClient.fastGet(file.remotePath, file.localPath, {
          step: (totalTransferred, _chunk, total) => {
            const fileTotalBytes = total > 0 ? total : file.size
            const nextTransferredBytes =
              transferredBytes + Math.min(file.size, Math.min(fileTotalBytes, totalTransferred))

            emitProgress?.('running', nextTransferredBytes, file.remotePath)
          }
        })

        transferredBytes += file.size
        emitProgress('running', transferredBytes, file.remotePath)
      }

      emitProgress('completed', totalBytes, downloadPlan.files.at(-1)?.remotePath ?? remotePath)
      return
    }

    totalBytes = remoteStats.size
    emitProgress = createSshDownloadProgressEmitter(
      webContents,
      downloadId,
      remotePath,
      localPath,
      totalBytes
    )

    emitProgress('running', 0, remotePath)

    await sftpClient.fastGet(remotePath, localPath, {
      step: (totalTransferred, _chunk, total) => {
        const fileTotalBytes = total > 0 ? total : totalBytes

        transferredBytes = Math.min(fileTotalBytes, totalTransferred)
        emitProgress?.('running', transferredBytes, remotePath)
      }
    })

    emitProgress('completed', totalBytes, remotePath)
  } catch (error) {
    emitProgress?.('failed', transferredBytes, remotePath)
    throw error
  } finally {
    await sftpClient.end().catch(() => false)
  }
}

function getUniqueDownloadPath(path: string): string {
  if (!existsSync(path)) {
    return path
  }

  const parsedPath = parse(path)
  const stem = parsedPath.ext === '' ? parsedPath.base : parsedPath.name
  let suffix = 1

  while (true) {
    const candidatePath = join(parsedPath.dir, `${stem} (${suffix})${parsedPath.ext}`)

    if (!existsSync(candidatePath)) {
      return candidatePath
    }

    suffix += 1
  }
}

function parsePersistedRestorableTabState(value: unknown): RestorableTabState | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  if (record.kind === 'local') {
    if (record.cwd !== undefined && typeof record.cwd !== 'string') {
      return null
    }

    const cwd =
      typeof record.cwd === 'string' && record.cwd.trim() !== '' ? record.cwd.trim() : undefined

    return cwd ? { cwd, kind: 'local' } : { kind: 'local' }
  }

  if (
    record.kind === 'ssh' &&
    typeof record.configId === 'string' &&
    record.configId.trim() !== ''
  ) {
    if (record.cwd !== undefined && typeof record.cwd !== 'string') {
      return null
    }

    if (record.browserPath !== undefined && typeof record.browserPath !== 'string') {
      return null
    }

    const cwd =
      typeof record.cwd === 'string' && record.cwd.trim() !== '' ? record.cwd.trim() : undefined
    const browserPath =
      typeof record.browserPath === 'string' && record.browserPath.trim() !== ''
        ? record.browserPath.trim()
        : undefined

    return {
      browserPath,
      cwd,
      configId: record.configId.trim(),
      kind: 'ssh'
    }
  }

  return null
}

function parsePersistedOutputLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const outputLines = value.filter((line): line is string => typeof line === 'string').slice(-500)

  return outputLines.length > 0 ? outputLines : undefined
}

function parsePersistedSessionTab(
  value: unknown,
  seenTabIds: Set<string>
): SessionTabSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''

  if (id === '' || seenTabIds.has(id)) {
    return null
  }

  if (typeof record.title !== 'string') {
    return null
  }

  const restoreState = parsePersistedRestorableTabState(record.restoreState)

  if (!restoreState) {
    return null
  }

  const outputLines =
    restoreState.kind === 'ssh' ? undefined : parsePersistedOutputLines(record.outputLines)

  seenTabIds.add(id)

  return {
    id,
    ...(outputLines ? { outputLines } : {}),
    restoreState,
    title: record.title.trim() || '~'
  }
}

function parsePersistedSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  if (record.version !== undefined && record.version !== 1) {
    return null
  }

  if (!Array.isArray(record.tabs)) {
    return null
  }

  const seenTabIds = new Set<string>()
  const tabs = record.tabs
    .map((tab) => parsePersistedSessionTab(tab, seenTabIds))
    .filter((tab): tab is SessionTabSnapshot => tab !== null)
  const activeTabId =
    typeof record.activeTabId === 'string' && tabs.some((tab) => tab.id === record.activeTabId)
      ? record.activeTabId
      : (tabs[0]?.id ?? null)

  return {
    activeTabId,
    tabs,
    version: 1
  }
}

function persistSessionSnapshot(snapshot: SessionSnapshot): void {
  try {
    writeFileSync(getSessionStorePath(), JSON.stringify(snapshot, null, 2), 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to persist session: ${message}`)
  }
}

const defaultAppStartupMode: AppStartupMode = 'restorePreviousSession'
const defaultTerminalColorSchemeId = 'midnight-blue'
const defaultTerminalFontFamilyId = 'JetBrains Mono Variable'
const defaultTerminalFontWeight = '400'
const defaultTerminalCursorStyle: TerminalCursorStyle = 'bar'
const defaultTerminalCursorBlink = true
const defaultTerminalCursorWidth = 2
const defaultTerminalLineHeight = 1.35
const minTerminalCursorWidth = 1
const maxTerminalCursorWidth = 6
const minTerminalLineHeight = 1
const maxTerminalLineHeight = 2

function parseSettingNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsedValue = Number(value)
    return Number.isFinite(parsedValue) ? parsedValue : null
  }

  return null
}

function parseSettingBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLocaleLowerCase()

    if (normalizedValue === 'true') {
      return true
    }

    if (normalizedValue === 'false') {
      return false
    }
  }

  return null
}

function normalizeTerminalThemeOverrideColor(color: unknown): string | null {
  if (typeof color !== 'string') {
    return null
  }

  const normalizedColor = color.trim().toLocaleLowerCase()
  const match = normalizedColor.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)

  if (!match) {
    return null
  }

  const hexColor = match[1]

  if (hexColor.length === 3) {
    return `#${hexColor
      .split('')
      .map((channel) => `${channel}${channel}`)
      .join('')}`
  }

  return `#${hexColor}`
}

function normalizeTerminalCursorColor(cursorColor: unknown): string | null {
  return normalizeTerminalThemeOverrideColor(cursorColor)
}

function normalizeTerminalSelectionColor(selectionColor: unknown): string | null {
  return normalizeTerminalThemeOverrideColor(selectionColor)
}

function parsePersistedMainWindowState(value: unknown): PersistedMainWindowState | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const boundsRecord =
    record.bounds && typeof record.bounds === 'object'
      ? (record.bounds as Record<string, unknown>)
      : null
  const widthValue = parseSettingNumber(boundsRecord?.width)
  const heightValue = parseSettingNumber(boundsRecord?.height)
  const xValue = parseSettingNumber(boundsRecord?.x)
  const yValue = parseSettingNumber(boundsRecord?.y)
  const isMaximizedValue = parseSettingBoolean(record.isMaximized)

  if (widthValue === null || heightValue === null) {
    return null
  }

  return {
    bounds: {
      ...(xValue === null ? {} : { x: Math.round(xValue) }),
      ...(yValue === null ? {} : { y: Math.round(yValue) }),
      width: Math.max(minMainWindowWidth, Math.round(widthValue)),
      height: Math.max(minMainWindowHeight, Math.round(heightValue))
    },
    isMaximized: isMaximizedValue ?? false
  }
}

function clampTerminalCursorWidth(cursorWidth: number): number {
  return Math.min(Math.max(Math.round(cursorWidth), minTerminalCursorWidth), maxTerminalCursorWidth)
}

function clampTerminalLineHeight(lineHeight: number): number {
  const clampedLineHeight = Math.min(
    Math.max(lineHeight, minTerminalLineHeight),
    maxTerminalLineHeight
  )
  return Math.round(clampedLineHeight * 100) / 100
}

function parsePersistedQuickCommand(value: unknown, seenIds: Set<string>): QuickCommand | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  if (
    typeof record.id !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.command !== 'string'
  ) {
    return null
  }

  const id = record.id.trim()
  const title = record.title.trim()
  const command = record.command.trim()

  if (id === '' || title === '' || command === '' || seenIds.has(id)) {
    return null
  }

  seenIds.add(id)

  return {
    command,
    id,
    title
  }
}

function parsePersistedSettings(value: unknown): AppSettings | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const generalValue = record.general
  const terminalValue = record.terminal

  if (record.version !== 1 || !terminalValue || typeof terminalValue !== 'object') {
    return null
  }

  const generalRecord =
    generalValue && typeof generalValue === 'object'
      ? (generalValue as Record<string, unknown>)
      : null
  const terminalRecord = terminalValue as Record<string, unknown>
  const fontSizeValue = parseSettingNumber(terminalRecord.fontSize)
  const cursorWidthValue = parseSettingNumber(terminalRecord.cursorWidth)
  const lineHeightValue = parseSettingNumber(terminalRecord.lineHeight)
  const cursorBlinkValue = parseSettingBoolean(terminalRecord.cursorBlink)
  const startupModeValue = generalRecord?.startupMode
  const defaultNewTabDirectoryValue = generalRecord?.defaultNewTabDirectory
  const quickCommands = Array.isArray(record.quickCommands)
    ? (() => {
        const seenIds = new Set<string>()

        return record.quickCommands
          .map((quickCommand) => parsePersistedQuickCommand(quickCommand, seenIds))
          .filter((quickCommand): quickCommand is QuickCommand => quickCommand !== null)
      })()
    : []

  if (
    typeof terminalRecord.colorSchemeId !== 'string' ||
    terminalRecord.colorSchemeId.trim() === '' ||
    typeof terminalRecord.fontFamilyId !== 'string' ||
    terminalRecord.fontFamilyId.trim() === '' ||
    fontSizeValue === null ||
    typeof terminalRecord.fontWeight !== 'string' ||
    terminalRecord.fontWeight.trim() === ''
  ) {
    return null
  }

  const startupMode =
    startupModeValue === 'startClean' || startupModeValue === 'restorePreviousSession'
      ? startupModeValue
      : defaultAppStartupMode
  const cursorStyle =
    terminalRecord.cursorStyle === 'block' ||
    terminalRecord.cursorStyle === 'underline' ||
    terminalRecord.cursorStyle === 'bar'
      ? terminalRecord.cursorStyle
      : defaultTerminalCursorStyle

  return {
    general: {
      defaultNewTabDirectory:
        typeof defaultNewTabDirectoryValue === 'string' ? defaultNewTabDirectoryValue.trim() : '',
      startupMode
    },
    quickCommands,
    terminal: {
      colorSchemeId: terminalRecord.colorSchemeId.trim(),
      cursorBlink: cursorBlinkValue ?? defaultTerminalCursorBlink,
      cursorColor: normalizeTerminalCursorColor(terminalRecord.cursorColor),
      selectionColor: normalizeTerminalSelectionColor(terminalRecord.selectionColor),
      cursorStyle,
      cursorWidth: clampTerminalCursorWidth(cursorWidthValue ?? defaultTerminalCursorWidth),
      fontFamilyId: terminalRecord.fontFamilyId.trim(),
      fontSize: Math.round(fontSizeValue),
      fontWeight: terminalRecord.fontWeight.trim(),
      lineHeight: clampTerminalLineHeight(lineHeightValue ?? defaultTerminalLineHeight)
    },
    version: 1
  }
}

function createDefaultAppSettings(): AppSettings {
  return {
    general: {
      defaultNewTabDirectory: '',
      startupMode: defaultAppStartupMode
    },
    quickCommands: [],
    terminal: {
      colorSchemeId: defaultTerminalColorSchemeId,
      cursorBlink: defaultTerminalCursorBlink,
      cursorColor: null,
      selectionColor: null,
      cursorStyle: defaultTerminalCursorStyle,
      cursorWidth: defaultTerminalCursorWidth,
      fontFamilyId: defaultTerminalFontFamilyId,
      fontSize: 14,
      fontWeight: defaultTerminalFontWeight,
      lineHeight: defaultTerminalLineHeight
    },
    version: 1
  }
}

function getSettingsForPersistence(): AppSettings {
  if (persistedSettings) {
    return persistedSettings
  }

  const defaultSettings = createDefaultAppSettings()
  persistedSettings = defaultSettings
  return defaultSettings
}

function persistSettings(
  settings: AppSettings,
  nextSshServers: SshServerConfig[] = sshServers
): void {
  try {
    writeFileSync(
      getSettingsStorePath(),
      JSON.stringify({ ...settings, sshServers: nextSshServers }, null, 2),
      'utf8'
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to persist settings: ${message}`)
  }
}

function persistMainWindowState(state: PersistedMainWindowState): void {
  try {
    writeFileSync(getMainWindowStateStorePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to persist main window state: ${message}`)
  }
}

function loadPersistedSettings(): void {
  const storePath = getSettingsStorePath()
  sshServers = []

  if (!existsSync(storePath)) {
    persistedSettings = null
    return
  }

  try {
    const rawValue = readFileSync(storePath, 'utf8')
    const parsedRawValue: unknown = JSON.parse(rawValue)
    const parsedValue = parsePersistedSettings(parsedRawValue)

    if (!parsedValue) {
      console.warn(`Unexpected settings store format in ${storePath}`)
      persistedSettings = null
      return
    }

    persistedSettings = parsedValue

    if (parsedRawValue && typeof parsedRawValue === 'object') {
      const sshServersValue = (parsedRawValue as Record<string, unknown>).sshServers

      if (sshServersValue !== undefined) {
        const parsedSshServers = parsePersistedSshServers(sshServersValue)

        if (!parsedSshServers) {
          console.warn(`Unexpected SSH server store format in ${storePath}`)
        } else {
          sshServers = parsedSshServers
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to load settings from ${storePath}`, error)
    persistedSettings = null
    sshServers = []
  }
}

function loadPersistedMainWindowState(): void {
  const storePath = getMainWindowStateStorePath()

  if (!existsSync(storePath)) {
    persistedMainWindowState = null
    return
  }

  try {
    const rawValue = readFileSync(storePath, 'utf8')
    const parsedValue = parsePersistedMainWindowState(JSON.parse(rawValue))

    if (!parsedValue) {
      console.warn(`Unexpected main window state store format in ${storePath}`)
      persistedMainWindowState = null
      return
    }

    persistedMainWindowState = parsedValue
  } catch (error) {
    console.warn(`Failed to load main window state from ${storePath}`, error)
    persistedMainWindowState = null
  }
}

function listPersistedSettings(): AppSettings | null {
  return persistedSettings
}

function saveSettings(settings: AppSettings): void {
  const parsedSettings = parsePersistedSettings(settings)

  if (!parsedSettings) {
    throw new Error('Invalid settings payload.')
  }

  persistSettings(parsedSettings)
  persistedSettings = parsedSettings
}

function serializePersistedSettings(
  settings: AppSettings,
  nextSshServers: SshServerConfig[] = sshServers
): string {
  return JSON.stringify({ ...settings, sshServers: nextSshServers }, null, 2)
}

async function exportSettingsToFile(): Promise<SettingsExportResult | null> {
  const dialogOptions: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath('documents'), 'terminal-settings.json'),
    filters: [
      {
        extensions: ['json'],
        name: 'JSON Files'
      }
    ],
    properties: ['showOverwriteConfirmation']
  }
  const owningWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = owningWindow
    ? await dialog.showSaveDialog(owningWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)

  if (result.canceled || !result.filePath) {
    return null
  }

  try {
    const storePath = getSettingsStorePath()
    const rawSettings = existsSync(storePath)
      ? readFileSync(storePath, 'utf8')
      : serializePersistedSettings(getSettingsForPersistence())

    writeFileSync(result.filePath, rawSettings, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to export settings: ${message}`)
  }

  return {
    filePath: result.filePath
  }
}

async function importSettingsFromFile(): Promise<SettingsImportResult | null> {
  const dialogOptions: Electron.OpenDialogOptions = {
    filters: [
      {
        extensions: ['json'],
        name: 'JSON Files'
      }
    ],
    properties: ['openFile']
  }
  const owningWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = owningWindow
    ? await dialog.showOpenDialog(owningWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]

  let parsedRawValue: unknown
  let rawValue = ''

  try {
    rawValue = readFileSync(filePath, 'utf8')
    parsedRawValue = JSON.parse(rawValue)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to read ${basename(filePath)}: ${message}`)
  }

  const parsedSettings = parsePersistedSettings(parsedRawValue)

  if (!parsedSettings) {
    throw new Error('The selected file does not contain valid app settings.')
  }

  if (parsedRawValue && typeof parsedRawValue === 'object') {
    const sshServersValue = (parsedRawValue as Record<string, unknown>).sshServers

    if (sshServersValue !== undefined) {
      const parsedSshServers = parsePersistedSshServers(sshServersValue)

      if (!parsedSshServers) {
        throw new Error('The selected file contains invalid SSH server settings.')
      }
    }
  }

  try {
    writeFileSync(getSettingsStorePath(), rawValue, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to import settings: ${message}`)
  }

  loadPersistedSettings()

  return {
    filePath,
    settings: persistedSettings ?? parsedSettings
  }
}

function loadPersistedSession(): void {
  const storePath = getSessionStorePath()

  if (!existsSync(storePath)) {
    persistedSession = null
    return
  }

  try {
    const rawValue = readFileSync(storePath, 'utf8')
    const parsedValue = parsePersistedSessionSnapshot(JSON.parse(rawValue))

    if (!parsedValue) {
      console.warn(`Unexpected session store format in ${storePath}`)
      persistedSession = null
      return
    }

    persistedSession = parsedValue
  } catch (error) {
    console.warn(`Failed to load session from ${storePath}`, error)
    persistedSession = null
  }
}

function listPersistedSession(): SessionSnapshot | null {
  return persistedSession
}

function stageSessionSnapshot(snapshot: SessionSnapshot): void {
  const parsedSnapshot = parsePersistedSessionSnapshot(snapshot)

  if (!parsedSnapshot) {
    throw new Error('Invalid session snapshot.')
  }

  persistedSession = parsedSnapshot
}

function flushStagedSessionSnapshot(): void {
  if (!persistedSession) {
    return
  }

  try {
    persistSessionSnapshot(persistedSession)
  } catch (error) {
    console.error('Unable to flush the staged terminal session.', error)
  }
}

function captureMainWindowState(window: BrowserWindow): PersistedMainWindowState {
  const bounds =
    window.isMaximized() || window.isMinimized() || window.isFullScreen()
      ? window.getNormalBounds()
      : window.getBounds()

  return {
    bounds: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    },
    isMaximized: window.isMaximized()
  }
}

function saveMainWindowState(window: BrowserWindow): void {
  try {
    const nextState = captureMainWindowState(window)
    persistMainWindowState(nextState)
    persistedMainWindowState = nextState
  } catch (error) {
    console.error('Unable to persist the main window state.', error)
  }
}

function canRestoreMainWindowBounds(bounds: MainWindowBounds): boolean {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
    return true
  }

  const { x, y, width, height } = bounds
  const right = x + width
  const bottom = y + height

  return screen.getAllDisplays().some(({ workArea }) => {
    const workAreaRight = workArea.x + workArea.width
    const workAreaBottom = workArea.y + workArea.height

    return x < workAreaRight && right > workArea.x && y < workAreaBottom && bottom > workArea.y
  })
}

function getMainWindowBounds(): MainWindowBounds {
  const bounds = persistedMainWindowState?.bounds

  if (!bounds || !canRestoreMainWindowBounds(bounds)) {
    return {
      width: defaultMainWindowWidth,
      height: defaultMainWindowHeight
    }
  }

  return bounds
}

function persistSshServers(nextSshServers: SshServerConfig[]): void {
  try {
    persistSettings(getSettingsForPersistence(), nextSshServers)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to persist SSH servers: ${message}`)
  }
}

function listSshServers(): SshServerConfig[] {
  return sshServers.map((config) => stripSshServerPassword(config))
}

function saveSshServer(config: SshServerConfig): void {
  const existingConfigIndex = sshServers.findIndex((server) => server.id === config.id)
  const nextSshServers =
    existingConfigIndex === -1
      ? [...sshServers, config]
      : sshServers.map((server, index) => (index === existingConfigIndex ? config : server))

  persistSshServers(nextSshServers)
  sshServers = nextSshServers
  invalidateSftpBrowserSessionsForConfig(config.id)
}

function deleteSshServer(configId: string): void {
  const existingConfig = sshServers.find((server) => server.id === configId)

  if (!existingConfig) {
    throw new Error('SSH server config not found.')
  }

  const nextSshServers = sshServers.filter((server) => server.id !== configId)

  persistSshServers(nextSshServers)
  sshServers = nextSshServers
  invalidateSftpBrowserSessionsForConfig(configId)
}

function resolveSshServerConnection(configId: string): {
  config: SshServerConfig
  password: string | null
} {
  const config = sshServers.find((server) => server.id === configId)

  if (!config) {
    throw new Error('SSH server config not found.')
  }

  return {
    config,
    password: config.authMethod === 'password' ? decryptSshPassword(config.password) : null
  }
}

function buildSshTerminalCreateOptions(
  config: SshServerConfig,
  password: string | null,
  cwd?: string
): TerminalCreateOptions {
  const sshPath = resolveExecutablePath('ssh')
  const args = buildSshBaseArgs(config)
  const env = getSshCommandEnv(password)
  const remoteStartPath = cwd?.trim() || config.defaultRemoteStartPath.trim() || undefined

  args.push(
    '-tt',
    `${config.username}@${config.host}`,
    buildInteractiveSshRemoteCommand(remoteStartPath)
  )

  return {
    args,
    command: sshPath,
    env,
    title: config.name,
    trackCwd: false
  }
}

function connectToSshServer(
  webContents: WebContents,
  payload: { configId: string; cwd?: string }
): TerminalCreateResult {
  const { config, password } = resolveSshServerConnection(payload.configId)

  return createTerminal(webContents, buildSshTerminalCreateOptions(config, password, payload.cwd))
}

async function listSshDirectory(
  webContents: WebContents,
  configId: string,
  path?: string
): Promise<SshRemoteDirectoryListing> {
  return runSftpBrowserSessionOperation(webContents, configId, async (sftpClient) => {
    const resolvedPath = await resolveSftpDirectoryPath(sftpClient, path)
    const entries = await sftpClient.list(resolvedPath)

    return {
      entries: entries
        .map((entry) => mapSftpFileInfoToRemoteEntry(entry))
        .sort((left, right) => left.name.localeCompare(right.name)),
      path: resolvedPath
    }
  })
}

async function createSshPath(configId: string, path: string, isDirectory: boolean): Promise<void> {
  const { config, password } = resolveSshServerConnection(configId)
  const normalizedPath = path.trim()

  if (normalizedPath === '') {
    throw new Error('Remote path is required.')
  }

  await runSshCommand(config, password, buildSshCreatePathCommand(normalizedPath, isDirectory))
}

async function deleteSshPath(configId: string, path: string, isDirectory: boolean): Promise<void> {
  const { config, password } = resolveSshServerConnection(configId)
  await runSshCommand(config, password, buildSshDeletePathCommand(path, isDirectory))
}

async function renameSshPath(configId: string, path: string, nextPath: string): Promise<void> {
  const { config, password } = resolveSshServerConnection(configId)
  await runSshCommand(config, password, buildSshRenamePathCommand(path, nextPath))
}

async function readSshTextFile(configId: string, path: string): Promise<SshRemoteTextFile> {
  const { config, password } = resolveSshServerConnection(configId)
  const normalizedPath = path.trim()

  if (normalizedPath === '') {
    throw new Error('Remote file path is required.')
  }

  const tempFilePath = join(app.getPath('temp'), `terminal-remote-file-${randomUUID()}.tmp`)

  try {
    await runScpCommand(config, password, normalizedPath, tempFilePath, false)
    const fileStats = statSync(tempFilePath)

    if (fileStats.size > maxSshRemoteTextFileBytes) {
      throw new Error(
        `This file is too large to edit here (${formatFileSize(fileStats.size)}). Limit: ${formatFileSize(maxSshRemoteTextFileBytes)}.`
      )
    }

    const fileBuffer = readFileSync(tempFilePath)

    if (!isProbablyTextBuffer(fileBuffer)) {
      throw new Error('This remote file looks binary and cannot be edited as text.')
    }

    return {
      content: fileBuffer.toString('utf8'),
      path: normalizedPath,
      size: fileStats.size
    }
  } finally {
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath)
    }
  }
}

async function writeSshTextFile(configId: string, path: string, content: string): Promise<void> {
  const { config, password } = resolveSshServerConnection(configId)
  const normalizedPath = path.trim()

  if (normalizedPath === '') {
    throw new Error('Remote file path is required.')
  }

  const nextContent = typeof content === 'string' ? content : ''
  const nextContentBuffer = Buffer.from(nextContent, 'utf8')

  if (nextContentBuffer.byteLength > maxSshRemoteTextFileBytes) {
    throw new Error(
      `This file is too large to save here (${formatFileSize(nextContentBuffer.byteLength)}). Limit: ${formatFileSize(maxSshRemoteTextFileBytes)}.`
    )
  }

  const tempFilePath = join(app.getPath('temp'), `terminal-remote-file-${randomUUID()}.tmp`)

  try {
    writeFileSync(tempFilePath, nextContentBuffer)
    await runScpUploadCommand(config, password, tempFilePath, normalizedPath)
  } finally {
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath)
    }
  }
}

async function readLocalTextFile(path: string): Promise<LocalTextFile> {
  const normalizedPath = path.trim()

  if (normalizedPath === '') {
    throw new Error('Local file path is required.')
  }

  let fileStats: ReturnType<typeof statSync>

  try {
    fileStats = statSync(normalizedPath)
  } catch {
    throw new Error('Local file not found.')
  }

  if (!fileStats.isFile()) {
    throw new Error('Only files can be edited here.')
  }

  if (fileStats.size > maxLocalTextFileBytes) {
    throw new Error(
      `This file is too large to edit here (${formatFileSize(fileStats.size)}). Limit: ${formatFileSize(maxLocalTextFileBytes)}.`
    )
  }

  const fileBuffer = readFileSync(normalizedPath)

  if (!isProbablyTextBuffer(fileBuffer)) {
    throw new Error('This local file looks binary and cannot be edited as text.')
  }

  return {
    content: fileBuffer.toString('utf8'),
    path: normalizedPath,
    size: fileStats.size
  }
}

async function writeLocalTextFile(path: string, content: string): Promise<void> {
  const normalizedPath = path.trim()

  if (normalizedPath === '') {
    throw new Error('Local file path is required.')
  }

  if (existsSync(normalizedPath) && !statSync(normalizedPath).isFile()) {
    throw new Error('Only files can be saved here.')
  }

  const nextContent = typeof content === 'string' ? content : ''
  const nextContentBuffer = Buffer.from(nextContent, 'utf8')

  if (nextContentBuffer.byteLength > maxLocalTextFileBytes) {
    throw new Error(
      `This file is too large to save here (${formatFileSize(nextContentBuffer.byteLength)}). Limit: ${formatFileSize(maxLocalTextFileBytes)}.`
    )
  }

  writeFileSync(normalizedPath, nextContentBuffer)
}

async function downloadSshPath(
  webContents: WebContents,
  configId: string,
  path: string,
  isDirectory: boolean
): Promise<string> {
  const { config, password } = resolveSshServerConnection(configId)
  const downloadsPath = app.getPath('downloads')
  const normalizedPath = path.trim()

  if (normalizedPath === '') {
    throw new Error('Remote path is required.')
  }

  mkdirSync(downloadsPath, { recursive: true })

  const normalizedName = basename(normalizedPath.replace(/\/+$/, '')) || 'download'
  const targetPath = getUniqueDownloadPath(join(downloadsPath, normalizedName))

  if (normalizedPath === '~' || normalizedPath.startsWith('~/')) {
    await runScpCommand(config, password, normalizedPath, targetPath, isDirectory)
    return targetPath
  }

  await runSftpDownloadCommand(webContents, config, password, normalizedPath, targetPath)

  return targetPath
}

async function uploadSshPaths(
  webContents: WebContents,
  configId: string,
  targetPath: string,
  localPaths: string[]
): Promise<void> {
  const { config, password } = resolveSshServerConnection(configId)

  const normalizedTargetPath = targetPath.trim()

  if (normalizedTargetPath === '') {
    throw new Error('Remote target path is required.')
  }

  const normalizedLocalPaths = Array.from(
    new Set(localPaths.map((localPath) => localPath.trim()).filter((localPath) => localPath !== ''))
  )

  if (normalizedLocalPaths.length === 0) {
    throw new Error('Add at least one local file to upload.')
  }

  for (const localPath of normalizedLocalPaths) {
    let stats

    try {
      stats = statSync(localPath)
    } catch {
      throw new Error(`Local path not found: ${localPath}`)
    }

    if (stats.isDirectory()) {
      continue
    }

    if (stats.isFile()) {
      continue
    }

    throw new Error(`Only files and folders can be uploaded: ${localPath}`)
  }
  await runSftpUploadCommand(
    webContents,
    config,
    password,
    normalizedLocalPaths,
    normalizedTargetPath
  )
}

async function openShellPath(path: string): Promise<void> {
  const normalizedPath = path.trim()

  if (normalizedPath === '' || !existsSync(normalizedPath)) {
    throw new Error('Path not found.')
  }

  const errorMessage = await shell.openPath(normalizedPath)

  if (errorMessage) {
    throw new Error(errorMessage)
  }
}

async function pickShellPaths(options?: ShellPickPathsOptions): Promise<string[]> {
  const allowDirectories = options?.allowDirectories !== false
  const allowFiles = options?.allowFiles !== false

  if (!allowDirectories && !allowFiles) {
    throw new Error('At least one path type must be selectable.')
  }

  const dialogOptions: Electron.OpenDialogOptions = {
    properties: [
      ...(allowFiles ? (['openFile'] as const) : []),
      ...(allowDirectories ? (['openDirectory'] as const) : []),
      ...(options?.multiSelections === false ? [] : (['multiSelections'] as const)),
      'dontAddToRecent'
    ],
    ...(options?.buttonLabel ? { buttonLabel: options.buttonLabel } : {}),
    ...(options?.title ? { title: options.title } : {})
  }
  const owningWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = owningWindow
    ? await dialog.showOpenDialog(owningWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)

  return result.canceled ? [] : result.filePaths
}

async function openExternalUrl(url: string): Promise<void> {
  const normalizedUrl = url.trim()

  if (normalizedUrl === '') {
    throw new Error('URL is required.')
  }

  await shell.openExternal(normalizedUrl)
}

function loadRendererWindow(window: BrowserWindow): Promise<void> {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  }

  return window.loadFile(join(__dirname, '../renderer/index.html'))
}

function isFindShortcutInput(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') {
    return false
  }

  return (input.meta || input.control) && input.key.toLowerCase() === 'f'
}

function createMainWindow(): BrowserWindow {
  const mainWindowBounds = getMainWindowBounds()
  const nextMainWindow = new BrowserWindow({
    title: 'Terminal',
    ...mainWindowBounds,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 16, y: 16 }
        }
      : {
          titleBarStyle: 'default' as const
        }),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  nextMainWindow.on('ready-to-show', () => {
    if (persistedMainWindowState?.isMaximized) {
      nextMainWindow.maximize()
    }

    nextMainWindow.show()
  })

  nextMainWindow.on('close', () => {
    saveMainWindowState(nextMainWindow)
  })

  nextMainWindow.on('closed', () => {
    flushStagedSessionSnapshot()
  })

  nextMainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  nextMainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isFindShortcutInput(input)) {
      return
    }

    event.preventDefault()

    if (!nextMainWindow.webContents.isDestroyed()) {
      nextMainWindow.webContents.send('terminal:find-requested')
    }
  })

  void loadRendererWindow(nextMainWindow)

  return nextMainWindow
}

function normalizeSshConfigInput(config: SshServerConfigInput): SshServerConfigInput {
  return {
    authMethod: config.authMethod,
    defaultRemoteStartPath: config.defaultRemoteStartPath.trim(),
    description: config.description.trim(),
    host: config.host.trim(),
    icon: normalizeSshServerIcon(config.icon),
    name: config.name.trim(),
    password: config.password,
    privateKeyPath: config.authMethod === 'privateKey' ? config.privateKeyPath.trim() : '',
    port: Number.isFinite(config.port) ? Math.max(1, Math.floor(config.port)) : 22,
    username: config.username.trim()
  }
}

function submitSshConfig(webContents: WebContents, payload: SshServerConfigSaveInput): void {
  const existingConfig = payload.id
    ? (sshServers.find((server) => server.id === payload.id) ?? null)
    : null

  if (payload.id && !existingConfig) {
    throw new Error('SSH server config not found.')
  }

  const normalizedConfig = normalizeSshConfigInput(payload)
  const encryptedPassword =
    normalizedConfig.authMethod === 'password'
      ? normalizedConfig.password !== ''
        ? encryptSshPassword(normalizedConfig.password)
        : existingConfig?.authMethod === 'password'
          ? existingConfig.password
          : ''
      : ''

  if (normalizedConfig.authMethod === 'password' && encryptedPassword === '') {
    throw new Error('Add a password for password authentication.')
  }

  const config: SshServerConfig = {
    id: existingConfig?.id ?? randomUUID(),
    ...normalizedConfig,
    password: encryptedPassword
  }

  saveSshServer(config)

  if (!webContents.isDestroyed()) {
    webContents.send('ssh:config-added', stripSshServerPassword(config))
  }
}

function removeSshConfig(webContents: WebContents, configId: string): void {
  deleteSshServer(configId)

  if (!webContents.isDestroyed()) {
    webContents.send('ssh:config-deleted', configId)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  ensureNodePtyHelpersExecutable()
  loadPersistedMainWindowState()
  loadPersistedSettings()
  loadPersistedSession()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('terminal:create', (event, options?: TerminalCreateOptions) =>
    createTerminal(event.sender, options)
  )
  ipcMain.handle('shell:open-external', (_event, url: string) => openExternalUrl(url))
  ipcMain.handle('shell:open-path', (_event, path: string) => openShellPath(path))
  ipcMain.handle('shell:pick-paths', (_event, options?: ShellPickPathsOptions) =>
    pickShellPaths(options)
  )
  ipcMain.handle('shell:read-text-file', (_event, path: string) => readLocalTextFile(path))
  ipcMain.handle('shell:write-text-file', (_event, payload: { content: string; path: string }) =>
    writeLocalTextFile(payload.path, payload.content)
  )
  ipcMain.handle('settings:export-to-file', () => exportSettingsToFile())
  ipcMain.handle('settings:import-from-file', () => importSettingsFromFile())
  ipcMain.handle('settings:load', () => listPersistedSettings())
  ipcMain.handle('settings:save', (_event, settings: AppSettings) => saveSettings(settings))
  ipcMain.handle('session:load', () => listPersistedSession())
  ipcMain.handle('session:save', (_event, snapshot: SessionSnapshot) =>
    stageSessionSnapshot(snapshot)
  )
  ipcMain.on('terminal:write', (_event, payload: { terminalId: number; data: string }) => {
    terminals.get(payload.terminalId)?.process.write(payload.data)
  })
  ipcMain.on(
    'terminal:resize',
    (_event, payload: { terminalId: number; cols: number; rows: number }) => {
      terminals
        .get(payload.terminalId)
        ?.process.resize(Math.max(20, payload.cols), Math.max(8, payload.rows))
    }
  )
  ipcMain.on('terminal:kill', (_event, terminalId: number) => {
    destroyTerminal(terminalId)
  })
  ipcMain.handle('ssh:list-configs', () => listSshServers())
  ipcMain.handle('ssh:connect', (event, payload: { configId: string; cwd?: string }) =>
    connectToSshServer(event.sender, payload)
  )
  ipcMain.handle(
    'ssh:create-path',
    (_event, payload: { configId: string; isDirectory: boolean; path: string }) =>
      createSshPath(payload.configId, payload.path, payload.isDirectory)
  )
  ipcMain.handle('ssh:delete-config', (event, configId: string) =>
    removeSshConfig(event.sender, configId)
  )
  ipcMain.handle(
    'ssh:delete-path',
    (_event, payload: { configId: string; isDirectory: boolean; path: string }) =>
      deleteSshPath(payload.configId, payload.path, payload.isDirectory)
  )
  ipcMain.handle(
    'ssh:download-path',
    (event, payload: { configId: string; isDirectory: boolean; path: string }) =>
      downloadSshPath(event.sender, payload.configId, payload.path, payload.isDirectory)
  )
  ipcMain.handle('ssh:list-directory', (event, payload: { configId: string; path?: string }) =>
    listSshDirectory(event.sender, payload.configId, payload.path)
  )
  ipcMain.handle('ssh:read-text-file', (_event, payload: { configId: string; path: string }) =>
    readSshTextFile(payload.configId, payload.path)
  )
  ipcMain.handle('ssh:remove-known-hosts', (_event, payload: { host: string; port: number }) =>
    removeKnownHostsEntries(payload.host, payload.port)
  )
  ipcMain.handle(
    'ssh:rename-path',
    (_event, payload: { configId: string; nextPath: string; path: string }) =>
      renameSshPath(payload.configId, payload.path, payload.nextPath)
  )
  ipcMain.handle(
    'ssh:upload-paths',
    (event, payload: { configId: string; localPaths: string[]; targetPath: string }) =>
      uploadSshPaths(event.sender, payload.configId, payload.targetPath, payload.localPaths)
  )
  ipcMain.handle(
    'ssh:write-text-file',
    (_event, payload: { configId: string; content: string; path: string }) =>
      writeSshTextFile(payload.configId, payload.path, payload.content)
  )
  ipcMain.handle('ssh:save-config', (event, payload: SshServerConfigSaveInput) =>
    submitSshConfig(event.sender, payload)
  )

  createMainWindow()

  app.on('before-quit', () => {
    flushStagedSessionSnapshot()
    destroyAllSftpBrowserSessions()
  })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
