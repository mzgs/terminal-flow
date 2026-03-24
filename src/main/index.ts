import { app, shell, safeStorage, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, type IPty } from 'node-pty'
import icon from '../../resources/icon.png?asset'
import type { SshServerConfig, SshServerConfigInput, SshServerConfigSaveInput } from '../shared/ssh'
import type { TerminalCreateOptions, TerminalCreateResult } from '../shared/terminal'

interface TerminalSession {
  cwdRefreshTimeout: NodeJS.Timeout | null
  lastCwd: string | null
  ownerId: number
  process: IPty
  shellName: string
  trackCwd: boolean
}

interface TerminalSpawnResult {
  cwd: string
  process: IPty
  shellName: string
  title: string
  trackCwd: boolean
}

const terminals = new Map<number, TerminalSession>()
const ownersWithCleanup = new Set<number>()
let nextTerminalId = 1
let sshServers: SshServerConfig[] = []
const sshServersStoreFileName = 'ssh-servers.json'
const sshPasswordsStoreFileName = 'ssh-passwords.json'
let sshPasswordBlobs = new Map<string, string>()

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
    const shellName = formatShellName(options.command)

    return {
      cwd,
      process: spawn(options.command, options.args ?? [], {
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

function sanitizeSshServerConfig(config: SshServerConfig): SshServerConfig {
  return {
    ...config,
    password: ''
  }
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

  return sanitizeSshServerConfig({
    id: record.id,
    authMethod: record.authMethod,
    description: record.description.trim(),
    host: record.host.trim(),
    name: record.name.trim(),
    password: '',
    port: Math.max(1, Math.floor(portValue)),
    username: record.username.trim()
  })
}

function getSshServersStorePath(): string {
  return join(app.getPath('userData'), sshServersStoreFileName)
}

function getSshPasswordsStorePath(): string {
  return join(app.getPath('userData'), sshPasswordsStoreFileName)
}

function getSshAskpassHelperPath(): string {
  return join(
    app.getPath('userData'),
    process.platform === 'win32' ? 'ssh-askpass.cmd' : 'ssh-askpass.sh'
  )
}

function isSecureSshPasswordStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    return false
  }

  if (process.platform === 'linux') {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  return true
}

function assertSecureSshPasswordStorageAvailable(): void {
  if (isSecureSshPasswordStorageAvailable()) {
    return
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure password storage is unavailable on this system.')
  }

  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error(
      'Secure password storage is unavailable because Electron is using the basic_text backend.'
    )
  }
}

function persistSshPasswords(): void {
  try {
    writeFileSync(
      getSshPasswordsStorePath(),
      JSON.stringify(Object.fromEntries(sshPasswordBlobs), null, 2),
      'utf8'
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to persist SSH passwords: ${message}`)
  }
}

function loadPersistedSshPasswords(): void {
  const storePath = getSshPasswordsStorePath()

  if (!existsSync(storePath)) {
    sshPasswordBlobs = new Map()
    return
  }

  try {
    const rawValue = readFileSync(storePath, 'utf8')
    const parsedValue: unknown = JSON.parse(rawValue)

    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      console.warn(`Unexpected SSH password store format in ${storePath}`)
      sshPasswordBlobs = new Map()
      return
    }

    sshPasswordBlobs = new Map(
      Object.entries(parsedValue).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )
    )
  } catch (error) {
    console.warn(`Failed to load SSH passwords from ${storePath}`, error)
    sshPasswordBlobs = new Map()
  }
}

function deleteStoredSshPassword(configId: string): void {
  if (!sshPasswordBlobs.delete(configId)) {
    return
  }

  persistSshPasswords()
}

function storeSshPassword(configId: string, password: string): void {
  if (password === '') {
    deleteStoredSshPassword(configId)
    return
  }

  assertSecureSshPasswordStorageAvailable()
  sshPasswordBlobs.set(configId, safeStorage.encryptString(password).toString('base64'))
  persistSshPasswords()
}

function getStoredSshPassword(configId: string): string | null {
  const encryptedPassword = sshPasswordBlobs.get(configId)

  if (!encryptedPassword) {
    return null
  }

  try {
    return safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'))
  } catch (error) {
    console.warn(`Failed to decrypt SSH password for ${configId}`, error)
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

function persistSshServers(nextSshServers: SshServerConfig[]): void {
  try {
    writeFileSync(
      getSshServersStorePath(),
      JSON.stringify(
        nextSshServers.map((config) => sanitizeSshServerConfig(config)),
        null,
        2
      ),
      'utf8'
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to persist SSH servers: ${message}`)
  }
}

function loadPersistedSshServers(): void {
  const storePath = getSshServersStorePath()

  if (!existsSync(storePath)) {
    sshServers = []
    return
  }

  try {
    const rawValue = readFileSync(storePath, 'utf8')
    const parsedValue: unknown = JSON.parse(rawValue)

    if (!Array.isArray(parsedValue)) {
      console.warn(`Unexpected SSH server store format in ${storePath}`)
      sshServers = []
      return
    }

    sshServers = parsedValue
      .map((config) => parsePersistedSshServerConfig(config))
      .filter((config): config is SshServerConfig => config !== null)
  } catch (error) {
    console.warn(`Failed to load SSH servers from ${storePath}`, error)
    sshServers = []
  }
}

function listSshServers(): SshServerConfig[] {
  return sshServers.map((config) => ({
    ...config
  }))
}

function saveSshServer(config: SshServerConfig): void {
  const sanitizedConfig = sanitizeSshServerConfig(config)
  const existingConfigIndex = sshServers.findIndex((server) => server.id === config.id)
  const nextSshServers =
    existingConfigIndex === -1
      ? [...sshServers, sanitizedConfig]
      : sshServers.map((server, index) => (index === existingConfigIndex ? sanitizedConfig : server))

  persistSshServers(nextSshServers)
  sshServers = nextSshServers
}

function buildSshTerminalCreateOptions(
  config: SshServerConfig,
  password: string | null
): TerminalCreateOptions {
  const args: string[] = []
  let env: Record<string, string> | undefined

  if (config.authMethod === 'password') {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PubkeyAuthentication=no'
    )

    if (password) {
      const askpassHelperPath = ensureSshAskpassHelper()

      if (askpassHelperPath) {
        env = {
          SSH_ASKPASS: askpassHelperPath,
          SSH_ASKPASS_REQUIRE: 'force',
          TERMINAL_SSH_PASSWORD: password
        }
      }
    }
  }

  args.push('-p', String(config.port), `${config.username}@${config.host}`)

  return {
    args,
    command: 'ssh',
    env,
    title: config.name,
    trackCwd: false
  }
}

function connectToSshServer(webContents: WebContents, configId: string): TerminalCreateResult {
  const config = sshServers.find((server) => server.id === configId)

  if (!config) {
    throw new Error('SSH server config not found.')
  }

  const password = config.authMethod === 'password' ? getStoredSshPassword(config.id) : null

  return createTerminal(webContents, buildSshTerminalCreateOptions(config, password))
}

function loadRendererWindow(window: BrowserWindow): Promise<void> {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  }

  return window.loadFile(join(__dirname, '../renderer/index.html'))
}

function createMainWindow(): BrowserWindow {
  const nextMainWindow = new BrowserWindow({
    title: 'Terminal',
    width: 1180,
    height: 760,
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
    nextMainWindow.show()
  })

  nextMainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  void loadRendererWindow(nextMainWindow)

  return nextMainWindow
}

function normalizeSshConfigInput(config: SshServerConfigInput): SshServerConfigInput {
  return {
    authMethod: config.authMethod,
    description: config.description.trim(),
    host: config.host.trim(),
    name: config.name.trim(),
    password: '',
    port: Number.isFinite(config.port) ? Math.max(1, Math.floor(config.port)) : 22,
    username: config.username.trim()
  }
}

function submitSshConfig(webContents: WebContents, payload: SshServerConfigSaveInput): void {
  const existingConfig = payload.id
    ? sshServers.find((server) => server.id === payload.id) ?? null
    : null

  if (payload.id && !existingConfig) {
    throw new Error('SSH server config not found.')
  }

  const config: SshServerConfig = {
    id: existingConfig?.id ?? randomUUID(),
    ...normalizeSshConfigInput(payload)
  }
  const previousPasswordBlob = sshPasswordBlobs.get(config.id)
  const shouldKeepStoredPassword =
    config.authMethod === 'password' &&
    payload.password === '' &&
    existingConfig?.authMethod === 'password' &&
    typeof previousPasswordBlob === 'string'

  try {
    if (config.authMethod === 'password') {
      if (payload.password !== '') {
        storeSshPassword(config.id, payload.password)
      } else if (!shouldKeepStoredPassword) {
        throw new Error('Add a password for password authentication.')
      }
    } else {
      deleteStoredSshPassword(config.id)
    }

    saveSshServer(config)
  } catch (error) {
    try {
      if (typeof previousPasswordBlob === 'string') {
        sshPasswordBlobs.set(config.id, previousPasswordBlob)
      } else {
        sshPasswordBlobs.delete(config.id)
      }

      persistSshPasswords()
    } catch (cleanupError) {
      console.warn(`Failed to restore SSH password state for ${config.id}`, cleanupError)
    }

    throw error
  }

  if (!webContents.isDestroyed()) {
    webContents.send('ssh:config-added', config)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  ensureNodePtyHelpersExecutable()
  loadPersistedSshServers()
  loadPersistedSshPasswords()

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
  ipcMain.handle('ssh:connect', (event, configId: string) =>
    connectToSshServer(event.sender, configId)
  )
  ipcMain.handle('ssh:save-config', (event, payload: SshServerConfigSaveInput) =>
    submitSshConfig(event.sender, payload)
  )

  createMainWindow()

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
