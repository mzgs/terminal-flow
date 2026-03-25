import { app, shell, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
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
const sshPasswordEncryptionSecret = 'T3rm!nal_SSH#2026$Vaulfe35dt@91xZ'
const sshPasswordEncryptionPrefix = 'enc-v1'
const sshPasswordEncryptionKey = createHash('sha256').update(sshPasswordEncryptionSecret).digest()

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

function stripSshServerPassword(config: SshServerConfig): SshServerConfig {
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

  return {
    id: record.id,
    authMethod: record.authMethod,
    description: record.description.trim(),
    host: record.host.trim(),
    name: record.name.trim(),
    password: typeof record.password === 'string' ? record.password : '',
    privateKeyPath: typeof record.privateKeyPath === 'string' ? record.privateKeyPath.trim() : '',
    port: Math.max(1, Math.floor(portValue)),
    username: record.username.trim()
  }
}

function getSshServersStorePath(): string {
  return join(app.getPath('userData'), sshServersStoreFileName)
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
    console.warn('Unexpected SSH password format in ssh-servers.json')
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
    console.warn('Failed to decrypt SSH password from ssh-servers.json', error)
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
    writeFileSync(getSshServersStorePath(), JSON.stringify(nextSshServers, null, 2), 'utf8')
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
}

function deleteSshServer(configId: string): void {
  const existingConfig = sshServers.find((server) => server.id === configId)

  if (!existingConfig) {
    throw new Error('SSH server config not found.')
  }

  const nextSshServers = sshServers.filter((server) => server.id !== configId)

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

  if (config.authMethod === 'privateKey' && config.privateKeyPath !== '') {
    args.push('-i', config.privateKeyPath, '-o', 'IdentitiesOnly=yes')
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

  const password = config.authMethod === 'password' ? decryptSshPassword(config.password) : null

  return createTerminal(webContents, buildSshTerminalCreateOptions(config, password))
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
  const nextMainWindow = new BrowserWindow({
    title: 'Terminal',
    width: 1000,
    height: 600,
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
    description: config.description.trim(),
    host: config.host.trim(),
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
  loadPersistedSshServers()

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
  ipcMain.handle('ssh:delete-config', (event, configId: string) =>
    removeSshConfig(event.sender, configId)
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
