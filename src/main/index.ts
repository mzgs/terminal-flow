import { app, shell, BrowserWindow, ipcMain, type WebContents } from 'electron'
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
import type { SshServerConfig, SshServerConfigInput } from '../shared/ssh'
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
let mainWindow: BrowserWindow | null = null
let sshConfigWindow: BrowserWindow | null = null
const sshServersStoreFileName = 'ssh-servers.json'

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

function getTerminalEnv(cwd: string): Record<string, string> {
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

  return env
}

function spawnTerminalProcess(options?: TerminalCreateOptions): TerminalSpawnResult {
  const cwd =
    options?.cwd && options.cwd.trim() !== '' && isDirectory(options.cwd.trim())
      ? options.cwd.trim()
      : getTerminalCwd()
  const env = getTerminalEnv(cwd)

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

function addSshServer(config: SshServerConfig): void {
  const nextSshServers = [...sshServers, sanitizeSshServerConfig(config)]

  persistSshServers(nextSshServers)
  sshServers = nextSshServers
}

function loadRendererWindow(window: BrowserWindow, windowMode?: string): Promise<void> {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])

    if (windowMode) {
      rendererUrl.searchParams.set('window', windowMode)
    }

    return window.loadURL(rendererUrl.toString())
  }

  return window.loadFile(join(__dirname, '../renderer/index.html'), {
    query: windowMode ? { window: windowMode } : undefined
  })
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

  nextMainWindow.on('closed', () => {
    mainWindow = null
  })

  nextMainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  void loadRendererWindow(nextMainWindow)
  mainWindow = nextMainWindow

  return nextMainWindow
}

function openSshConfigWindow(parentWindow?: BrowserWindow | null): void {
  if (sshConfigWindow && !sshConfigWindow.isDestroyed()) {
    sshConfigWindow.focus()
    return
  }

  const ownerWindow = parentWindow && !parentWindow.isDestroyed() ? parentWindow : mainWindow
  const nextSshConfigWindow = new BrowserWindow({
    title: 'Add SSH Server',
    width: 540,
    height: 700,
    minWidth: 540,
    minHeight: 700,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#08111b',
    parent: ownerWindow ?? undefined,
    modal: process.platform !== 'linux' && Boolean(ownerWindow),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  nextSshConfigWindow.on('ready-to-show', () => {
    nextSshConfigWindow.show()
  })

  nextSshConfigWindow.on('closed', () => {
    sshConfigWindow = null
  })

  nextSshConfigWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  void loadRendererWindow(nextSshConfigWindow, 'ssh-config')
  sshConfigWindow = nextSshConfigWindow
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

function submitSshConfig(sourceWindow: BrowserWindow, payload: SshServerConfigInput): void {
  const config: SshServerConfig = {
    id: randomUUID(),
    ...normalizeSshConfigInput(payload)
  }
  const parentWindow = sourceWindow.getParentWindow()
  const targetWindow = parentWindow && !parentWindow.isDestroyed() ? parentWindow : mainWindow

  addSshServer(config)

  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send('ssh:config-added', config)
  }

  sourceWindow.close()
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
  ipcMain.handle('ssh:open-config-window', (event) => {
    openSshConfigWindow(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.handle('ssh:list-configs', () => listSshServers())
  ipcMain.handle('ssh:save-config', (event, payload: SshServerConfigInput) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender)

    if (!sourceWindow) {
      return
    }

    submitSshConfig(sourceWindow, payload)
  })
  ipcMain.handle('ssh:close-config-window', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

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
