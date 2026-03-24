import { app, shell, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, type IPty } from 'node-pty'
import icon from '../../resources/icon.png?asset'
import type { TerminalCreateResult } from '../shared/terminal'

interface TerminalSession {
  cwdRefreshTimeout: NodeJS.Timeout | null
  lastCwd: string | null
  ownerId: number
  process: IPty
  shellName: string
}

const terminals = new Map<number, TerminalSession>()
const ownersWithCleanup = new Set<number>()
let nextTerminalId = 1

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

function spawnTerminalProcess(cwd: string): { process: IPty; shellName: string } {
  const env = getTerminalEnv(cwd)
  const failures: string[] = []

  for (const shellPath of getShellCandidates()) {
    try {
      return {
        process: spawn(shellPath, [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd,
          env
        }),
        shellName: formatShellName(shellPath)
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

function createTerminal(webContents: WebContents): TerminalCreateResult {
  registerOwnerCleanup(webContents)

  const terminalId = nextTerminalId++
  const cwd = getTerminalCwd()
  const { process: terminalProcess, shellName } = spawnTerminalProcess(cwd)
  const session: TerminalSession = {
    cwdRefreshTimeout: null,
    lastCwd: null,
    ownerId: webContents.id,
    process: terminalProcess,
    shellName
  }

  terminals.set(terminalId, session)
  startTerminalCwdTracking(terminalId, session, webContents, cwd)

  terminalProcess.onData((data) => {
    if (!webContents.isDestroyed()) {
      webContents.send('terminal:data', { terminalId, data })
    }

    queueTerminalCwdRefresh(terminalId, session, webContents)
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
    title: formatTerminalTitle(cwd, shellName)
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    title: 'Terminal',
    width: 1180,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  ensureNodePtyHelpersExecutable()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('terminal:create', (event) => createTerminal(event.sender))
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

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
