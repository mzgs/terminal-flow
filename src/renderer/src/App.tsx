import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IBufferCell, type ITheme } from '@xterm/xterm'
import {
  BrushCleaning,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ClipboardPaste,
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileTerminal,
  FileText,
  FileVideoCamera,
  Folder,
  FolderOpen,
  HardDrive,
  Pencil,
  Plus,
  Search,
  Server,
  TextSelect,
  Trash2,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Reorder, useDragControls } from 'motion/react'
import Modal from 'react-modal'
import '@xterm/xterm/css/xterm.css'
import type { RestorableTabState, SessionSnapshot, SessionTabSnapshot } from '../../shared/session'
import {
  defaultSshServerIcon,
  type SshAuthMethod,
  type SshDownloadProgressEvent,
  type SshRemoteDirectoryEntry,
  type SshServerIcon,
  type SshServerConfig,
  type SshServerConfigInput,
  type SshUploadProgressEvent
} from '../../shared/ssh'
import type { TerminalCreateOptions, TerminalCreateResult } from '../../shared/terminal'

type TabStatus = 'connecting' | 'ready' | 'closed'

interface TabRecord {
  id: string
  outputLines?: string[]
  reconnectAttempt?: number
  restoreState: RestorableTabState
  status: TabStatus
  terminalId: number | null
  title: string
  exitCode?: number
  errorMessage?: string
}

interface TerminalRuntime {
  closed: boolean
  disposed: boolean
  disposeInput: { dispose: () => void }
  fitAddon: FitAddon
  terminal: Terminal
  terminalId: number | null
}

interface CreateTabOptions {
  createTerminal?: () => Promise<TerminalCreateResult>
  restoreState?: RestorableTabState
  terminalCreateOptions?: TerminalCreateOptions
  title?: string
}

interface SearchMatch {
  col: number
  row: number
  size: number
}

interface SearchableLine {
  endRow: number
  positions: Array<Pick<SearchMatch, 'col' | 'row'>>
  startRow: number
  text: string
  widths: number[]
}

interface SshBrowserState {
  configId: string
  entries: SshRemoteDirectoryEntry[]
  errorMessage: string | null
  isLoading: boolean
  path: string | null
  requestId: number
  tabId: string
}

type SshBrowserStates = Record<string, SshBrowserState>
type SshBrowserWidths = Record<string, number>

interface SshBrowserContextMenuState {
  entry: SshRemoteDirectoryEntry
  tabId: string
  x: number
  y: number
}

interface TerminalContextMenuState {
  quickDownloadAction: TerminalQuickDownloadAction | null
  quickExtractAction: TerminalQuickExtractAction | null
  selectionText: string
  tabId: string
  x: number
  y: number
}

interface TerminalQuickDownloadAction {
  configId: string
  fileName: string
  remotePath: string
}

interface TerminalQuickExtractAction {
  command: string
}

interface SshBrowserFileIconDescriptor {
  icon: LucideIcon
  toneClassName: string
}

interface SshServerIconOption {
  label: string
  src: string
  value: SshServerIcon
}

const defaultTabTitle = '~'
const maxPersistedTerminalOutputLines = 500
const searchRefreshDebounceMs = 120
const defaultSshBrowserWidth = 320
const maxSshBrowserWidth = 640
const minSshBrowserWidth = 240
const minTerminalStageWidth = 320
const sshBrowserOverlayBreakpointPx = 900
const sshBrowserResizerWidth = 10
const sshRemoteCwdSequencePrefix = '\x1b]633;TerminalRemoteCwd='
const uploadProgressCircleRadius = 16
const uploadProgressCircleCircumference = 2 * Math.PI * uploadProgressCircleRadius
const sshRemoteCwdPattern = new RegExp(
  String.raw`\x1b]633;TerminalRemoteCwd=([^\x07\x1b]*)(?:\x07|\x1b\\)`,
  'g'
)
const defaultSshBrowserFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: File,
  toneClassName: 'ssh-browser-entry-icon-file'
}
const sshBrowserArchiveFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: FileArchive,
  toneClassName: 'ssh-browser-entry-icon-archive'
}
const terminalExtractableArchiveSuffixes = [
  '.tar.gz',
  '.tar.bz2',
  '.tar.xz',
  '.tgz',
  '.tbz2',
  '.txz',
  '.targz',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz'
] as const
const sshBrowserCodeFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: FileCode,
  toneClassName: 'ssh-browser-entry-icon-code'
}
const sshBrowserImageFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: FileImage,
  toneClassName: 'ssh-browser-entry-icon-image'
}
const sshBrowserAudioFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: FileMusic,
  toneClassName: 'ssh-browser-entry-icon-audio'
}
const sshBrowserScriptFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: FileTerminal,
  toneClassName: 'ssh-browser-entry-icon-script'
}
const sshBrowserTextFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: FileText,
  toneClassName: 'ssh-browser-entry-icon-text'
}
const sshBrowserVideoFileIconDescriptor: SshBrowserFileIconDescriptor = {
  icon: FileVideoCamera,
  toneClassName: 'ssh-browser-entry-icon-video'
}
const sshBrowserFileIconByExactName = new Map<string, SshBrowserFileIconDescriptor>([
  ['.editorconfig', sshBrowserCodeFileIconDescriptor],
  ['.env', sshBrowserTextFileIconDescriptor],
  ['.gitignore', sshBrowserCodeFileIconDescriptor],
  ['.npmrc', sshBrowserCodeFileIconDescriptor],
  ['.yarnrc', sshBrowserCodeFileIconDescriptor],
  ['dockerfile', sshBrowserCodeFileIconDescriptor],
  ['makefile', sshBrowserCodeFileIconDescriptor],
  ['readme', sshBrowserTextFileIconDescriptor]
])
const sshBrowserFileIconBySuffix = new Map<string, SshBrowserFileIconDescriptor>([
  ['.tar.gz', sshBrowserArchiveFileIconDescriptor],
  ['.tar.bz2', sshBrowserArchiveFileIconDescriptor],
  ['.tar.xz', sshBrowserArchiveFileIconDescriptor],
  ['.tgz', sshBrowserArchiveFileIconDescriptor],
  ['.tbz2', sshBrowserArchiveFileIconDescriptor],
  ['.txz', sshBrowserArchiveFileIconDescriptor],
  ['.targz', sshBrowserArchiveFileIconDescriptor],
  ['.zip', sshBrowserArchiveFileIconDescriptor],
  ['.7z', sshBrowserArchiveFileIconDescriptor],
  ['.rar', sshBrowserArchiveFileIconDescriptor],
  ['.tar', sshBrowserArchiveFileIconDescriptor],
  ['.gz', sshBrowserArchiveFileIconDescriptor],
  ['.bz2', sshBrowserArchiveFileIconDescriptor],
  ['.xz', sshBrowserArchiveFileIconDescriptor],
  ['.sh', sshBrowserScriptFileIconDescriptor],
  ['.bash', sshBrowserScriptFileIconDescriptor],
  ['.zsh', sshBrowserScriptFileIconDescriptor],
  ['.fish', sshBrowserScriptFileIconDescriptor],
  ['.ksh', sshBrowserScriptFileIconDescriptor],
  ['.command', sshBrowserScriptFileIconDescriptor],
  ['.ps1', sshBrowserScriptFileIconDescriptor],
  ['.bat', sshBrowserScriptFileIconDescriptor],
  ['.cmd', sshBrowserScriptFileIconDescriptor],
  ['.ts', sshBrowserCodeFileIconDescriptor],
  ['.tsx', sshBrowserCodeFileIconDescriptor],
  ['.js', sshBrowserCodeFileIconDescriptor],
  ['.jsx', sshBrowserCodeFileIconDescriptor],
  ['.mjs', sshBrowserCodeFileIconDescriptor],
  ['.cjs', sshBrowserCodeFileIconDescriptor],
  ['.json', sshBrowserCodeFileIconDescriptor],
  ['.jsonc', sshBrowserCodeFileIconDescriptor],
  ['.yaml', sshBrowserCodeFileIconDescriptor],
  ['.yml', sshBrowserCodeFileIconDescriptor],
  ['.toml', sshBrowserCodeFileIconDescriptor],
  ['.xml', sshBrowserCodeFileIconDescriptor],
  ['.html', sshBrowserCodeFileIconDescriptor],
  ['.htm', sshBrowserCodeFileIconDescriptor],
  ['.css', sshBrowserCodeFileIconDescriptor],
  ['.scss', sshBrowserCodeFileIconDescriptor],
  ['.sass', sshBrowserCodeFileIconDescriptor],
  ['.less', sshBrowserCodeFileIconDescriptor],
  ['.vue', sshBrowserCodeFileIconDescriptor],
  ['.py', sshBrowserCodeFileIconDescriptor],
  ['.rb', sshBrowserCodeFileIconDescriptor],
  ['.php', sshBrowserCodeFileIconDescriptor],
  ['.java', sshBrowserCodeFileIconDescriptor],
  ['.kt', sshBrowserCodeFileIconDescriptor],
  ['.go', sshBrowserCodeFileIconDescriptor],
  ['.rs', sshBrowserCodeFileIconDescriptor],
  ['.c', sshBrowserCodeFileIconDescriptor],
  ['.cc', sshBrowserCodeFileIconDescriptor],
  ['.cpp', sshBrowserCodeFileIconDescriptor],
  ['.h', sshBrowserCodeFileIconDescriptor],
  ['.hpp', sshBrowserCodeFileIconDescriptor],
  ['.sql', sshBrowserCodeFileIconDescriptor],
  ['.png', sshBrowserImageFileIconDescriptor],
  ['.jpg', sshBrowserImageFileIconDescriptor],
  ['.jpeg', sshBrowserImageFileIconDescriptor],
  ['.gif', sshBrowserImageFileIconDescriptor],
  ['.webp', sshBrowserImageFileIconDescriptor],
  ['.svg', sshBrowserImageFileIconDescriptor],
  ['.bmp', sshBrowserImageFileIconDescriptor],
  ['.ico', sshBrowserImageFileIconDescriptor],
  ['.tif', sshBrowserImageFileIconDescriptor],
  ['.tiff', sshBrowserImageFileIconDescriptor],
  ['.avif', sshBrowserImageFileIconDescriptor],
  ['.heic', sshBrowserImageFileIconDescriptor],
  ['.mp3', sshBrowserAudioFileIconDescriptor],
  ['.wav', sshBrowserAudioFileIconDescriptor],
  ['.flac', sshBrowserAudioFileIconDescriptor],
  ['.ogg', sshBrowserAudioFileIconDescriptor],
  ['.m4a', sshBrowserAudioFileIconDescriptor],
  ['.aac', sshBrowserAudioFileIconDescriptor],
  ['.opus', sshBrowserAudioFileIconDescriptor],
  ['.mp4', sshBrowserVideoFileIconDescriptor],
  ['.mov', sshBrowserVideoFileIconDescriptor],
  ['.mkv', sshBrowserVideoFileIconDescriptor],
  ['.avi', sshBrowserVideoFileIconDescriptor],
  ['.webm', sshBrowserVideoFileIconDescriptor],
  ['.m4v', sshBrowserVideoFileIconDescriptor],
  ['.wmv', sshBrowserVideoFileIconDescriptor],
  ['.txt', sshBrowserTextFileIconDescriptor],
  ['.md', sshBrowserTextFileIconDescriptor],
  ['.mdx', sshBrowserTextFileIconDescriptor],
  ['.rst', sshBrowserTextFileIconDescriptor],
  ['.log', sshBrowserTextFileIconDescriptor],
  ['.ini', sshBrowserTextFileIconDescriptor],
  ['.cfg', sshBrowserTextFileIconDescriptor],
  ['.conf', sshBrowserTextFileIconDescriptor],
  ['.csv', sshBrowserTextFileIconDescriptor]
])
const defaultTerminalTheme = {
  background: '#000000',
  black: '#000000',
  blue: '#7aa2f7',
  brightBlack: '#4c566a',
  brightBlue: '#8db0ff',
  brightCyan: '#7de3ff',
  brightGreen: '#98f5a7',
  brightMagenta: '#d6a3ff',
  brightRed: '#ff8e8e',
  brightWhite: '#ffffff',
  brightYellow: '#ffe08a',
  cursor: '#f5f5f5',
  cursorAccent: '#000000',
  cyan: '#63d3ff',
  foreground: '#f5f5f5',
  green: '#8fe388',
  magenta: '#c792ea',
  red: '#ff7b72',
  selectionBackground: 'rgba(255, 255, 255, 0.18)',
  selectionInactiveBackground: 'rgba(255, 255, 255, 0.18)',
  white: '#f5f5f5',
  yellow: '#e6c15a'
} satisfies ITheme
const searchTerminalTheme = {
  ...defaultTerminalTheme,
  selectionBackground: '#e0cb7d',
  selectionForeground: '#171102',
  selectionInactiveBackground: '#ffd84a'
} satisfies ITheme
const sshServerIconLabelOverrides: Record<string, string> = {
  almalinux: 'AlmaLinux',
  centos: 'CentOS',
  cloudflare: 'Cloudflare',
  coolify: 'Coolify',
  'db-ui': 'Database',
  debian: 'Debian',
  digitalocean: 'DigitalOcean',
  diskover: 'Hard Disk',
  docker: 'Docker',
  drivebase: 'Storage',
  linux: 'Linux',
  'linuxserver-io': 'Server',
  mariadb: 'MariaDB',
  mongodb: 'MongoDB',
  mysql: 'MySQL',
  nginx: 'Nginx',
  opensearch: 'OpenSearch',
  openvpn: 'OpenVPN',
  portainer: 'Portainer',
  postgresql: 'PostgreSQL',
  proxmox: 'Proxmox',
  rabbitmq: 'RabbitMQ',
  redis: 'Redis',
  shellhub: 'Shell',
  'truenas-scale': 'TrueNAS Scale',
  ubuntu: 'Ubuntu',
  unraid: 'Unraid',
  'visual-db': 'Visual DB',
  'vmware-esx': 'VMware ESX',
  wireguard: 'WireGuard'
}
const sshServerIconModules = import.meta.glob('./assets/ssh-icons/*.svg', {
  eager: true,
  import: 'default'
}) as Record<string, string>

function getSshServerIconValueFromModulePath(modulePath: string): SshServerIcon | null {
  const match = /\/([^/]+)\.svg$/i.exec(modulePath)
  return match?.[1] ?? null
}

function formatSshServerIconLabel(value: SshServerIcon): string {
  const overrideLabel = sshServerIconLabelOverrides[value]

  if (overrideLabel) {
    return overrideLabel
  }

  return value
    .split(/[-_]+/)
    .filter((segment) => segment !== '')
    .map((segment) => {
      if (segment.length <= 3) {
        return segment.toUpperCase()
      }

      return `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`
    })
    .join(' ')
}

const sshServerIconOptions = Object.entries(sshServerIconModules)
  .map(([modulePath, src]) => {
    const value = getSshServerIconValueFromModulePath(modulePath)

    if (!value) {
      return null
    }

    return {
      label: formatSshServerIconLabel(value),
      src,
      value
    }
  })
  .filter((option): option is SshServerIconOption => option !== null)
  .sort((leftOption, rightOption) => leftOption.label.localeCompare(rightOption.label))
const sshServerIconOptionsByValue = new Map(
  sshServerIconOptions.map((option) => [option.value, option])
)
const fallbackSshServerIconOption =
  sshServerIconOptionsByValue.get(defaultSshServerIcon) ?? sshServerIconOptions[0] ?? null
const defaultRendererSshServerIcon = fallbackSshServerIconOption?.value ?? defaultSshServerIcon
const fallbackSshServerIconSrc = fallbackSshServerIconOption?.src ?? null

const terminalOptions = {
  allowTransparency: true,
  cursorBlink: true,
  cursorStyle: 'bar',
  cursorWidth: 2,
  fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 14,
  lineHeight: 1.35,
  macOptionIsMeta: true,
  scrollback: 5000,
  theme: defaultTerminalTheme
} satisfies ConstructorParameters<typeof Terminal>[0]

const defaultSshConfigInput: SshServerConfigInput = {
  authMethod: 'privateKey',
  description: '',
  host: '',
  icon: defaultRendererSshServerIcon,
  name: '',
  password: '',
  privateKeyPath: '',
  port: 22,
  username: 'root'
}

function cloneRestorableTabState(restoreState: RestorableTabState): RestorableTabState {
  if (restoreState.kind === 'ssh') {
    return {
      ...(restoreState.browserPath ? { browserPath: restoreState.browserPath } : {}),
      ...(restoreState.cwd ? { cwd: restoreState.cwd } : {}),
      configId: restoreState.configId,
      kind: 'ssh'
    }
  }

  return restoreState.cwd
    ? {
        cwd: restoreState.cwd,
        kind: 'local'
      }
    : {
        kind: 'local'
      }
}

function getDefaultRestorableTabState(): RestorableTabState {
  return { kind: 'local' }
}

function clonePersistedOutputLines(outputLines?: string[]): string[] | undefined {
  if (!outputLines || outputLines.length === 0) {
    return undefined
  }

  return outputLines.slice(-maxPersistedTerminalOutputLines)
}

function getPersistedTerminalOutputLines(terminal: Terminal): string[] | undefined {
  const cursorRow = terminal.buffer.active.baseY + terminal.buffer.active.cursorY
  const outputLines = buildSearchableLines(terminal)
    .filter((line) => line.endRow < cursorRow)
    .map((line) => line.text)
    .slice(-maxPersistedTerminalOutputLines)

  return outputLines.length > 0 ? outputLines : undefined
}

function restorePersistedTerminalOutput(terminal: Terminal, outputLines?: string[]): void {
  if (!outputLines || outputLines.length === 0) {
    return
  }

  terminal.write(outputLines.join('\r\n'))
  terminal.write('\r\n')
}

function shouldPersistTabOutputLines(restoreState: RestorableTabState): boolean {
  return restoreState.kind !== 'ssh'
}

function getRestorableTabs(
  tabs: TabRecord[],
  getOutputLines: (tab: TabRecord) => string[] | undefined
): SessionTabSnapshot[] {
  return tabs
    .filter((tab) => tab.status !== 'closed' && !tab.errorMessage)
    .map((tab) => {
      const outputLines = shouldPersistTabOutputLines(tab.restoreState)
        ? getOutputLines(tab)
        : undefined

      return {
        id: tab.id,
        ...(outputLines ? { outputLines } : {}),
        restoreState: cloneRestorableTabState(tab.restoreState),
        title: tab.title
      }
    })
}

function createSessionSnapshot(
  tabs: TabRecord[],
  activeTabId: string | null,
  getOutputLines: (tab: TabRecord) => string[] | undefined
): SessionSnapshot {
  const restorableTabs = getRestorableTabs(tabs, getOutputLines)
  const nextActiveTabId = restorableTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (restorableTabs[0]?.id ?? null)

  return {
    activeTabId: nextActiveTabId,
    tabs: restorableTabs,
    version: 1
  }
}

function buildCreateTabOptionsFromSessionTab(tab: SessionTabSnapshot): CreateTabOptions {
  if (tab.restoreState.kind === 'ssh') {
    const { configId, cwd } = tab.restoreState

    return {
      createTerminal: () => window.api.ssh.connect(configId, cwd),
      restoreState: cloneRestorableTabState(tab.restoreState)
    }
  }

  return {
    restoreState: cloneRestorableTabState(tab.restoreState),
    terminalCreateOptions: tab.restoreState.cwd ? { cwd: tab.restoreState.cwd } : undefined
  }
}

function createTabRecordFromSessionTab(tab: SessionTabSnapshot): TabRecord {
  return {
    id: tab.id,
    outputLines: clonePersistedOutputLines(tab.outputLines),
    restoreState: cloneRestorableTabState(tab.restoreState),
    status: 'connecting',
    terminalId: null,
    title: tab.title
  }
}

function getNextTabSequence(tabs: Array<Pick<SessionTabSnapshot, 'id'>>): number {
  let nextSequence = 1

  for (const tab of tabs) {
    const match = /^tab-(\d+)$/.exec(tab.id)

    if (!match) {
      continue
    }

    const sequenceNumber = Number(match[1])

    if (Number.isSafeInteger(sequenceNumber)) {
      nextSequence = Math.max(nextSequence, sequenceNumber + 1)
    }
  }

  return nextSequence
}

function usesWindowsShellQuoting(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
}

function shouldHandleFileDrop(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false
  }

  const transferTypes = Array.from(dataTransfer.types)
  return transferTypes.includes('Files') || transferTypes.includes('text/uri-list')
}

function parseDroppedFileUrl(value: string): string | null {
  if (!value.startsWith('file://')) {
    return null
  }

  try {
    const parsedUrl = new URL(value)

    if (parsedUrl.protocol !== 'file:') {
      return null
    }

    let path = decodeURIComponent(parsedUrl.pathname)

    if (/^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1)
    }

    return path || null
  } catch {
    return null
  }
}

function getPathsFromUriList(dataTransfer: DataTransfer): string[] {
  const uriList = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain')

  if (!uriList) {
    return []
  }

  return uriList
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value !== '' && !value.startsWith('#'))
    .map((value) => parseDroppedFileUrl(value))
    .filter((value): value is string => Boolean(value))
}

function quoteArgumentForShell(
  value: string,
  useWindowsQuoting: boolean = usesWindowsShellQuoting()
): string {
  if (useWindowsQuoting) {
    return /[\s&()[\]{}^=;!'+,`~]/.test(value) ? `"${value}"` : value
  }

  return value.replace(/([^A-Za-z0-9_./~:-])/g, '\\$1')
}

function quotePathForShell(
  path: string,
  useWindowsQuoting: boolean = usesWindowsShellQuoting()
): string {
  return quoteArgumentForShell(path, useWindowsQuoting)
}

function stripSshRemoteCwdSequences(
  data: string,
  carryover: string
): { carryover: string; cleanedData: string; cwd: string | null } {
  const combinedData = carryover + data
  let nextCarryover = ''
  const lastPrefixIndex = combinedData.lastIndexOf(sshRemoteCwdSequencePrefix)

  if (lastPrefixIndex >= 0) {
    const suffix = combinedData.slice(lastPrefixIndex)

    if (!suffix.includes('\x07') && !suffix.includes('\x1b\\')) {
      nextCarryover = suffix
    }
  }

  const processableData = nextCarryover
    ? combinedData.slice(0, combinedData.length - nextCarryover.length)
    : combinedData
  let cwd: string | null = null

  const cleanedData = processableData.replace(sshRemoteCwdPattern, (_match, nextCwd: string) => {
    const normalizedCwd = nextCwd.trim()

    if (normalizedCwd !== '') {
      cwd = normalizedCwd
    }

    return ''
  })

  return { carryover: nextCarryover, cleanedData, cwd }
}

function joinRemoteDirectoryPath(basePath: string, name: string): string {
  return basePath === '/' ? `/${name}` : `${basePath.replace(/\/+$/, '')}/${name}`
}

function getRemotePathBaseName(path: string): string {
  const normalizedPath = path.replace(/\/+$/, '')

  if (normalizedPath === '' || normalizedPath === '/') {
    return path
  }

  const lastSlashIndex = normalizedPath.lastIndexOf('/')

  return lastSlashIndex >= 0 ? normalizedPath.slice(lastSlashIndex + 1) : normalizedPath
}

function unwrapBalancedQuotes(value: string): string {
  if (value.length < 2) {
    return value
  }

  const firstCharacter = value[0]
  const lastCharacter = value[value.length - 1]

  if (
    (firstCharacter === "'" && lastCharacter === "'") ||
    (firstCharacter === '"' && lastCharacter === '"') ||
    (firstCharacter === '`' && lastCharacter === '`')
  ) {
    return value.slice(1, -1).trim()
  }

  return value
}

function normalizeTerminalSelectionForRemotePath(selectionText: string): string | null {
  const normalizedSelection = unwrapBalancedQuotes(selectionText.replace(/\r/g, '').trim())

  if (
    normalizedSelection === '' ||
    normalizedSelection === '.' ||
    normalizedSelection === '..' ||
    normalizedSelection === '~' ||
    normalizedSelection.endsWith('/') ||
    normalizedSelection.includes('\n')
  ) {
    return null
  }

  return normalizedSelection
}

function normalizeTerminalSelectionForArchivePath(selectionText: string): string | null {
  const normalizedSelection = unwrapBalancedQuotes(selectionText.replace(/\r/g, '').trim())

  if (
    normalizedSelection === '' ||
    normalizedSelection === '.' ||
    normalizedSelection === '..' ||
    normalizedSelection.endsWith('/') ||
    normalizedSelection.endsWith('\\') ||
    normalizedSelection.includes('\n')
  ) {
    return null
  }

  return normalizedSelection
}

function buildTerminalExtractArchiveCommand(
  archiveSelection: string,
  suffix: (typeof terminalExtractableArchiveSuffixes)[number],
  useWindowsShellQuoting: boolean
): string {
  const quotedArchiveSelection = quotePathForShell(archiveSelection, useWindowsShellQuoting)

  if (suffix === '.zip') {
    return useWindowsShellQuoting
      ? `tar -xf ${quotedArchiveSelection}`
      : `unzip ${quotedArchiveSelection}`
  }

  if (
    suffix === '.tar' ||
    suffix === '.tar.gz' ||
    suffix === '.tar.bz2' ||
    suffix === '.tar.xz' ||
    suffix === '.tgz' ||
    suffix === '.tbz2' ||
    suffix === '.txz' ||
    suffix === '.targz'
  ) {
    return `tar -xf ${quotedArchiveSelection}`
  }

  if (suffix === '.gz') {
    return `gzip -dk ${quotedArchiveSelection}`
  }

  if (suffix === '.bz2') {
    return `bzip2 -dk ${quotedArchiveSelection}`
  }

  if (suffix === '.xz') {
    return `xz -dk ${quotedArchiveSelection}`
  }

  return `tar -xf ${quotedArchiveSelection}`
}

function getTerminalQuickExtractAction(
  tab: TabRecord,
  selectionText: string
): TerminalQuickExtractAction | null {
  const archivePath = normalizeTerminalSelectionForArchivePath(selectionText)

  if (!archivePath) {
    return null
  }

  const normalizedSelection = archivePath.toLowerCase()
  const suffix = terminalExtractableArchiveSuffixes.find((candidateSuffix) =>
    normalizedSelection.endsWith(candidateSuffix)
  )

  if (!suffix) {
    return null
  }

  const command = buildTerminalExtractArchiveCommand(
    archivePath,
    suffix,
    tab.restoreState.kind === 'local' && usesWindowsShellQuoting()
  )

  return {
    command
  }
}

function normalizeRemotePath(path: string): string {
  if (path === '' || path === '/') {
    return '/'
  }

  const isAbsolutePath = path.startsWith('/')
  const normalizedSegments: string[] = []

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }

    if (segment === '..') {
      if (
        normalizedSegments.length > 0 &&
        normalizedSegments[normalizedSegments.length - 1] !== '..'
      ) {
        normalizedSegments.pop()
      } else if (!isAbsolutePath) {
        normalizedSegments.push(segment)
      }

      continue
    }

    normalizedSegments.push(segment)
  }

  if (isAbsolutePath) {
    return normalizedSegments.length === 0 ? '/' : `/${normalizedSegments.join('/')}`
  }

  return normalizedSegments.join('/')
}

function getTerminalQuickDownloadAction(
  tab: TabRecord,
  selectionText: string
): TerminalQuickDownloadAction | null {
  if (tab.restoreState.kind !== 'ssh') {
    return null
  }

  const normalizedSelection = normalizeTerminalSelectionForRemotePath(selectionText)

  if (!normalizedSelection) {
    return null
  }

  let remotePath: string | null = null

  if (
    normalizedSelection === '~' ||
    normalizedSelection.startsWith('~/') ||
    normalizedSelection.startsWith('/')
  ) {
    remotePath = normalizeRemotePath(normalizedSelection)
  } else if (tab.restoreState.cwd) {
    remotePath = normalizeRemotePath(
      joinRemoteDirectoryPath(tab.restoreState.cwd, normalizedSelection)
    )
  }

  if (!remotePath) {
    return null
  }

  if (remotePath === '/' || remotePath === '~') {
    return null
  }

  return {
    configId: tab.restoreState.configId,
    fileName: getRemotePathBaseName(remotePath),
    remotePath
  }
}

function getRemoteDirectoryParentPath(path: string): string | null {
  if (path === '/') {
    return null
  }

  const normalizedPath = path.replace(/\/+$/, '')

  if (normalizedPath === '') {
    return '/'
  }

  const lastSlashIndex = normalizedPath.lastIndexOf('/')

  if (lastSlashIndex <= 0) {
    return '/'
  }

  return normalizedPath.slice(0, lastSlashIndex)
}

function clampSshBrowserWidth(desiredWidth: number, workspaceWidth: number): number {
  const maxWidth = Math.min(
    maxSshBrowserWidth,
    Math.max(minSshBrowserWidth, workspaceWidth - minTerminalStageWidth - sshBrowserResizerWidth)
  )

  return Math.min(Math.max(Math.round(desiredWidth), minSshBrowserWidth), maxWidth)
}

function getSshBrowserFileIconDescriptor(fileName: string): SshBrowserFileIconDescriptor {
  const normalizedFileName = fileName.trim().toLowerCase()

  if (normalizedFileName === '') {
    return defaultSshBrowserFileIconDescriptor
  }

  const exactDescriptor = sshBrowserFileIconByExactName.get(normalizedFileName)

  if (exactDescriptor) {
    return exactDescriptor
  }

  for (const [suffix, descriptor] of sshBrowserFileIconBySuffix) {
    if (normalizedFileName.endsWith(suffix)) {
      return descriptor
    }
  }

  return defaultSshBrowserFileIconDescriptor
}

function getTabStatusLabel(tab: TabRecord): string {
  if (tab.status === 'connecting') {
    if (tab.restoreState.kind === 'ssh' && typeof tab.reconnectAttempt === 'number') {
      return 'Reconnecting'
    }

    return 'Starting'
  }

  if (tab.errorMessage) {
    return 'Failed'
  }

  return ''
}
function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  )
}

function isXtermHelperTextarea(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea')
}

function appendSearchCell(
  searchableLine: SearchableLine,
  row: number,
  col: number,
  cell: IBufferCell
): void {
  const width = cell.getWidth()

  if (width === 0) {
    return
  }

  let cellText = cell.getChars()

  if (cellText === '') {
    cellText = cell.getCode() === 0 ? ' ' : String.fromCodePoint(cell.getCode())
  }

  for (let index = 0; index < cellText.length; index += 1) {
    searchableLine.text += cellText[index]
    searchableLine.positions.push({ col, row })
    searchableLine.widths.push(index === 0 ? Math.max(1, width) : 0)
  }
}

function trimSearchableLine(searchableLine: SearchableLine, startIndex: number): void {
  while (searchableLine.text.length > startIndex && searchableLine.text.endsWith(' ')) {
    searchableLine.text = searchableLine.text.slice(0, -1)
    searchableLine.positions.pop()
    searchableLine.widths.pop()
  }
}

function buildSearchableLines(terminal: Terminal): SearchableLine[] {
  const searchableLines: SearchableLine[] = []
  const activeBuffer = terminal.buffer.active

  for (let row = 0; row < activeBuffer.length; row += 1) {
    const line = activeBuffer.getLine(row)

    if (!line || line.isWrapped) {
      continue
    }

    const searchableLine: SearchableLine = {
      endRow: row,
      positions: [],
      startRow: row,
      text: '',
      widths: []
    }

    let currentRow = row

    while (true) {
      const currentLine = activeBuffer.getLine(currentRow)

      if (!currentLine) {
        break
      }

      const segmentStartIndex = searchableLine.text.length

      for (let col = 0; col < terminal.cols; col += 1) {
        const cell = currentLine.getCell(col)

        if (!cell) {
          continue
        }

        appendSearchCell(searchableLine, currentRow, col, cell)
      }

      const nextLine = activeBuffer.getLine(currentRow + 1)

      if (!nextLine?.isWrapped) {
        trimSearchableLine(searchableLine, segmentStartIndex)
        break
      }

      currentRow += 1
    }

    searchableLines.push(searchableLine)
    searchableLine.endRow = currentRow
    row = currentRow
  }

  return searchableLines
}

function getSearchMatches(terminal: Terminal, query: string): SearchMatch[] {
  const normalizedQuery = query.toLocaleLowerCase()

  if (normalizedQuery === '') {
    return []
  }

  const matches: SearchMatch[] = []

  for (const searchableLine of buildSearchableLines(terminal)) {
    const normalizedLineText = searchableLine.text.toLocaleLowerCase()
    let searchStartIndex = 0

    while (searchStartIndex <= normalizedLineText.length - normalizedQuery.length) {
      const matchIndex = normalizedLineText.indexOf(normalizedQuery, searchStartIndex)

      if (matchIndex === -1) {
        break
      }

      const matchPosition = searchableLine.positions[matchIndex]

      if (matchPosition) {
        let matchSize = 0

        for (
          let index = matchIndex;
          index < Math.min(searchableLine.widths.length, matchIndex + normalizedQuery.length);
          index += 1
        ) {
          matchSize += searchableLine.widths[index] ?? 0
        }

        if (matchSize > 0) {
          matches.push({
            ...matchPosition,
            size: matchSize
          })
        }
      }

      searchStartIndex = matchIndex + Math.max(1, normalizedQuery.length)
    }
  }

  return matches
}

function selectSearchMatch(terminal: Terminal, match: SearchMatch): void {
  terminal.clearSelection()
  terminal.select(match.col, match.row, match.size)

  const viewportTop = terminal.buffer.active.viewportY
  const viewportBottom = viewportTop + terminal.rows

  if (match.row >= viewportBottom || match.row < viewportTop) {
    terminal.scrollLines(match.row - viewportTop - Math.floor(terminal.rows / 2))
  }
}

interface ReorderableTabProps {
  closeTab: (tabId: string) => void
  index: number
  isActive: boolean
  onActivateTab: (tabId: string) => void
  tab: TabRecord
}

function ReorderableTab({
  closeTab,
  index,
  isActive,
  onActivateTab,
  tab
}: ReorderableTabProps): React.JSX.Element {
  const dragControls = useDragControls()
  const tabStatusLabel = getTabStatusLabel(tab)

  return (
    <Reorder.Item
      as="div"
      className={`tab-item${isActive ? ' is-active' : ''}`}
      dragControls={dragControls}
      dragListener={false}
      value={tab}
      whileDrag={{
        boxShadow: '0 16px 32px rgba(0, 0, 0, 0.38)',
        scale: 1.02,
        zIndex: 3
      }}
    >
      <button
        aria-controls={`panel-${tab.id}`}
        aria-selected={isActive}
        className="tab-button"
        onAuxClick={(event) => {
          if (event.button !== 1) {
            return
          }

          event.preventDefault()
          closeTab(tab.id)
        }}
        onClick={() => onActivateTab(tab.id)}
        onPointerDown={(event) => {
          if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
            return
          }

          dragControls.start(event)
        }}
        role="tab"
        title={tab.title}
        type="button"
      >
        <span className={`tab-status-dot tab-status-${tab.status}`} aria-hidden="true" />
        <span className="tab-copy">
          <span className="tab-label">{tab.title}</span>
          {tabStatusLabel ? <span className="tab-meta">{tabStatusLabel}</span> : null}
        </span>
      </button>
      <button
        aria-label={`Close tab ${index + 1}`}
        className="tab-close"
        onClick={(event) => {
          event.stopPropagation()
          closeTab(tab.id)
        }}
        type="button"
      >
        <X aria-hidden="true" className="tab-close-icon" />
      </button>
    </Reorder.Item>
  )
}

function SshIcon(): React.JSX.Element {
  return <Server aria-hidden="true" className="tab-action-icon" />
}

function formatSshTarget(config: Pick<SshServerConfigInput, 'host' | 'port' | 'username'>): string {
  return `${config.username}@${config.host}:${config.port}`
}

function upsertSshServers(
  currentConfigs: SshServerConfig[],
  nextConfigs: SshServerConfig[]
): SshServerConfig[] {
  const configsById = new Map(currentConfigs.map((config) => [config.id, config]))

  for (const config of nextConfigs) {
    configsById.set(config.id, config)
  }

  return Array.from(configsById.values())
}

function removeSshServer(currentConfigs: SshServerConfig[], configId: string): SshServerConfig[] {
  return currentConfigs.filter((config) => config.id !== configId)
}

function createSshConfigFormState(
  serverConfig: SshServerConfig | null | undefined
): SshServerConfigInput {
  if (!serverConfig) {
    return { ...defaultSshConfigInput }
  }

  return {
    authMethod: serverConfig.authMethod,
    description: serverConfig.description,
    host: serverConfig.host,
    icon: sshServerIconOptionsByValue.has(serverConfig.icon)
      ? serverConfig.icon
      : defaultRendererSshServerIcon,
    name: serverConfig.name,
    password: '',
    privateKeyPath: serverConfig.privateKeyPath,
    port: serverConfig.port,
    username: serverConfig.username
  }
}

interface SshServerIconGlyphProps {
  className?: string
  icon?: SshServerIcon | null
}

function getSshServerIconSrc(icon: SshServerIcon | null | undefined): string {
  return (
    sshServerIconOptionsByValue.get(icon ?? defaultRendererSshServerIcon)?.src ??
    fallbackSshServerIconSrc ??
    ''
  )
}

function SshServerIconGlyph({
  className = 'tab-action-icon',
  icon = defaultRendererSshServerIcon
}: SshServerIconGlyphProps): React.JSX.Element {
  const iconSrc = getSshServerIconSrc(icon)

  return iconSrc ? (
    <img alt="" aria-hidden="true" className={className} draggable={false} src={iconSrc} />
  ) : (
    <Server aria-hidden="true" className={className} />
  )
}

interface SshConfigDialogProps {
  onClose: () => void
  serverConfig: SshServerConfig | null
}

interface SshServerIconSelectProps {
  disabled?: boolean
  onChange: (icon: SshServerIcon) => void
  value: SshServerIcon
}

function SshServerIconSelect({
  disabled = false,
  onChange,
  value
}: SshServerIconSelectProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const selectedOption = sshServerIconOptionsByValue.get(value) ?? fallbackSshServerIconOption
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredOptions = sshServerIconOptions.filter((option) => {
    if (normalizedQuery === '') {
      return true
    }

    return (
      option.label.toLocaleLowerCase().includes(normalizedQuery) ||
      option.value.toLocaleLowerCase().includes(normalizedQuery)
    )
  })

  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus()
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) {
        return
      }

      setIsOpen(false)
      setQuery('')
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setIsOpen(false)
      setQuery('')
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOpen])

  const handleToggleOpen = useCallback((): void => {
    if (disabled) {
      return
    }

    if (isOpen) {
      setIsOpen(false)
      setQuery('')
      return
    }

    setIsOpen(true)
  }, [disabled, isOpen])

  const handleSelect = useCallback(
    (icon: SshServerIcon): void => {
      onChange(icon)
      setIsOpen(false)
      setQuery('')
    },
    [onChange]
  )

  const selectedIconLabel = selectedOption?.label ?? 'Server'

  return (
    <div className={`ssh-icon-select${isOpen ? ' is-open' : ''}`} ref={rootRef}>
      <button
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`Choose SSH server icon. Selected: ${selectedIconLabel}.`}
        className="ssh-icon-select-trigger"
        disabled={disabled}
        onClick={handleToggleOpen}
        title={selectedIconLabel}
        type="button"
      >
        <SshServerIconGlyph
          className="ssh-icon-select-trigger-glyph"
          icon={selectedOption?.value}
        />
      </button>
      {isOpen ? (
        <div className="ssh-icon-select-dropdown">
          <div className="ssh-icon-select-search-shell">
            <Search aria-hidden="true" className="ssh-icon-select-search-icon" />
            <input
              aria-label="Search SSH server icons"
              className="ssh-icon-select-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search icons"
              ref={searchInputRef}
              type="text"
              value={query}
            />
          </div>
          <div
            aria-label="SSH server icons"
            className="ssh-icon-select-list"
            id={listboxId}
            role="listbox"
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const isSelected = value === option.value

                return (
                  <button
                    key={option.value}
                    aria-selected={isSelected}
                    className={`ssh-icon-select-option${isSelected ? ' is-active' : ''}`}
                    onClick={() => handleSelect(option.value)}
                    role="option"
                    title={option.label}
                    type="button"
                  >
                    <img
                      alt=""
                      aria-hidden="true"
                      className="ssh-icon-select-option-glyph"
                      draggable={false}
                      src={option.src}
                    />
                    <span className="ssh-icon-select-option-label">{option.label}</span>
                  </button>
                )
              })
            ) : (
              <p className="ssh-icon-select-empty">No icons match that search.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SshConfigDialog({ onClose, serverConfig }: SshConfigDialogProps): React.JSX.Element {
  const isEditing = serverConfig !== null
  const [formState, setFormState] = useState<SshServerConfigInput>(() =>
    createSshConfigFormState(serverConfig)
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isOtherSettingsOpen, setIsOtherSettingsOpen] = useState(() =>
    Boolean(serverConfig?.description || serverConfig?.privateKeyPath)
  )
  const connectionNameInputId = useId()
  const sshKeyFileInputRef = useRef<HTMLInputElement>(null)
  const isBusy = isDeleting || isSaving

  const updateField = useCallback(function updateField<TField extends keyof SshServerConfigInput>(
    field: TField,
    value: SshServerConfigInput[TField]
  ): void {
    setFormState((currentState) => ({
      ...currentState,
      [field]: value
    }))
    setErrorMessage(null)
  }, [])

  const updateAuthMethod = useCallback((authMethod: SshAuthMethod): void => {
    setFormState((currentState) => ({
      ...currentState,
      authMethod,
      password: authMethod === 'password' ? currentState.password : ''
    }))
    setErrorMessage(null)
  }, [])

  const toggleOtherSettings = useCallback((): void => {
    setIsOtherSettingsOpen((currentState) => !currentState)
  }, [])

  const handleSelectPrivateKeyFile = useCallback((): void => {
    sshKeyFileInputRef.current?.click()
  }, [])

  const handlePrivateKeyFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const selectedFile = event.target.files?.[0]

      if (!selectedFile) {
        return
      }

      const nextPath = window.api.webUtils.getPathForFile(selectedFile)
      event.target.value = ''

      if (!nextPath) {
        setErrorMessage('Unable to read the selected SSH key file path.')
        return
      }

      updateField('privateKeyPath', nextPath)
    },
    [updateField]
  )

  const handleCancel = useCallback((): void => {
    if (isBusy) {
      return
    }

    onClose()
  }, [isBusy, onClose])

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!serverConfig || isBusy) {
      return
    }

    setErrorMessage(null)
    setIsDeleting(true)

    try {
      await window.api.ssh.deleteConfig(serverConfig.id)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message || 'Unable to delete this SSH server.')
      setIsDeleting(false)
    }
  }, [isBusy, onClose, serverConfig])

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()

      const normalizedFormState: SshServerConfigInput = {
        ...formState,
        description: formState.description.trim(),
        host: formState.host.trim(),
        name: formState.name.trim(),
        port: Number.isFinite(formState.port) ? Math.max(1, Math.floor(formState.port)) : 22,
        privateKeyPath:
          formState.authMethod === 'privateKey' ? formState.privateKeyPath.trim() : '',
        username: formState.username.trim()
      }

      if (!normalizedFormState.name || !normalizedFormState.host || !normalizedFormState.username) {
        setErrorMessage('Name, host, and username are required.')
        return
      }

      const canReuseStoredPassword =
        normalizedFormState.authMethod === 'password' &&
        normalizedFormState.password === '' &&
        serverConfig?.authMethod === 'password'

      if (
        normalizedFormState.authMethod === 'password' &&
        normalizedFormState.password === '' &&
        !canReuseStoredPassword
      ) {
        setErrorMessage('Add a password for password authentication.')
        return
      }

      setErrorMessage(null)
      setIsSaving(true)

      try {
        await window.api.ssh.saveConfig({
          ...normalizedFormState,
          id: serverConfig?.id
        })
        onClose()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setErrorMessage(message || 'Unable to save this SSH server.')
        setIsSaving(false)
      }
    },
    [formState, onClose, serverConfig]
  )

  return (
    <Modal
      appElement={document.getElementById('root') ?? undefined}
      aria={{
        labelledby: 'ssh-config-title'
      }}
      bodyOpenClassName="ssh-config-modal-open"
      className="ssh-config-card ssh-config-dialog"
      contentLabel={isEditing ? 'Edit SSH server config' : 'Add SSH server config'}
      isOpen
      onRequestClose={handleCancel}
      overlayClassName="ssh-config-dialog-shell"
      shouldCloseOnEsc={!isBusy}
      shouldCloseOnOverlayClick={!isBusy}
    >
      <div className="ssh-config-header">
        <div className="ssh-config-header-main">
          <span className="ssh-config-eyebrow">SSH Server</span>
          <h2 className="ssh-config-title" id="ssh-config-title">
            {isEditing ? 'Edit SSH server' : 'Add SSH server config'}
          </h2>
          {!isEditing ? (
            <p className="ssh-config-copy">
              Save a host definition in the main window menu for this session.
            </p>
          ) : null}
        </div>
        <button
          aria-label="Close SSH server dialog"
          className="ssh-config-dismiss"
          disabled={isBusy}
          onClick={handleCancel}
          type="button"
        >
          <X aria-hidden="true" className="ssh-config-dismiss-icon" />
        </button>
      </div>
      <form className="ssh-config-form" onSubmit={handleSubmit}>
        <div className="ssh-field">
          <label className="ssh-field-label" htmlFor={connectionNameInputId}>
            Connection name
          </label>
          <div className="ssh-connection-name-row">
            <SshServerIconSelect
              disabled={isBusy}
              onChange={(icon) => updateField('icon', icon)}
              value={formState.icon}
            />
            <input
              autoFocus
              className="ssh-field-input"
              id={connectionNameInputId}
              onChange={(event) => updateField('name', event.target.value)}
              placeholder="Production API"
              type="text"
              value={formState.name}
            />
          </div>
        </div>
        <div className="ssh-config-grid">
          <label className="ssh-field">
            <span className="ssh-field-label">Host</span>
            <input
              className="ssh-field-input"
              onChange={(event) => updateField('host', event.target.value)}
              placeholder="server.example.com"
              type="text"
              value={formState.host}
            />
          </label>
          <label className="ssh-field">
            <span className="ssh-field-label">Port</span>
            <input
              className="ssh-field-input"
              min={1}
              onChange={(event) => updateField('port', Number(event.target.value) || 22)}
              placeholder="22"
              type="number"
              value={formState.port}
            />
          </label>
        </div>
        <label className="ssh-field">
          <span className="ssh-field-label">Username</span>
          <input
            className="ssh-field-input"
            onChange={(event) => updateField('username', event.target.value)}
            placeholder="ubuntu"
            type="text"
            value={formState.username}
          />
        </label>
        <div className="ssh-field">
          <span className="ssh-field-label">Authentication</span>
          <div className="ssh-auth-options" role="radiogroup">
            <button
              aria-checked={formState.authMethod === 'privateKey'}
              className={`ssh-auth-option${formState.authMethod === 'privateKey' ? ' is-active' : ''}`}
              onClick={() => updateAuthMethod('privateKey')}
              role="radio"
              type="button"
            >
              Private key
            </button>
            <button
              aria-checked={formState.authMethod === 'password'}
              className={`ssh-auth-option${formState.authMethod === 'password' ? ' is-active' : ''}`}
              onClick={() => updateAuthMethod('password')}
              role="radio"
              type="button"
            >
              Password
            </button>
          </div>
        </div>
        {formState.authMethod === 'password' ? (
          <label className="ssh-field">
            <span className="ssh-field-label">Password</span>
            <input
              className="ssh-field-input"
              onChange={(event) => updateField('password', event.target.value)}
              placeholder="Enter the account password"
              type="password"
              value={formState.password}
            />
            {serverConfig?.authMethod === 'password' ? (
              <span className="ssh-field-help">Leave blank to keep the existing password.</span>
            ) : null}
          </label>
        ) : null}
        <div className={`ssh-config-disclosure${isOtherSettingsOpen ? ' is-open' : ''}`}>
          <button
            aria-controls="ssh-other-settings-panel"
            aria-expanded={isOtherSettingsOpen}
            className={`ssh-config-disclosure-toggle${isOtherSettingsOpen ? ' is-open' : ''}`}
            disabled={isBusy}
            onClick={toggleOtherSettings}
            type="button"
          >
            <span className="ssh-config-disclosure-labels">
              <span className="ssh-config-disclosure-title">Other settings</span>
            </span>
            <span aria-hidden="true" className="ssh-config-disclosure-action">
              <span className="ssh-config-disclosure-icon-shell">
                <ChevronDown
                  aria-hidden="true"
                  className={`ssh-config-disclosure-icon${isOtherSettingsOpen ? ' is-open' : ''}`}
                />
              </span>
            </span>
          </button>
          {isOtherSettingsOpen ? (
            <div className="ssh-config-disclosure-panel" id="ssh-other-settings-panel">
              {formState.authMethod === 'privateKey' ? (
                <div className="ssh-field">
                  <span className="ssh-field-label">Custom SSH key file</span>
                  <div className="ssh-file-picker">
                    <input
                      className="ssh-field-input ssh-file-picker-input"
                      onChange={(event) => updateField('privateKeyPath', event.target.value)}
                      placeholder="/Users/name/.ssh/id_ed25519"
                      type="text"
                      value={formState.privateKeyPath}
                    />
                    <div className="ssh-file-picker-actions">
                      <input
                        hidden
                        onChange={handlePrivateKeyFileChange}
                        ref={sshKeyFileInputRef}
                        type="file"
                      />
                      <button
                        aria-label="Choose SSH key file"
                        className="ssh-file-picker-button ssh-file-picker-button-icon"
                        disabled={isBusy}
                        onClick={handleSelectPrivateKeyFile}
                        title="Choose SSH key file"
                        type="button"
                      >
                        <FolderOpen
                          aria-hidden="true"
                          className="ssh-file-picker-button-icon-glyph"
                        />
                      </button>
                      {formState.privateKeyPath ? (
                        <button
                          className="ssh-file-picker-clear"
                          disabled={isBusy}
                          onClick={() => updateField('privateKeyPath', '')}
                          type="button"
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <span className="ssh-field-help">
                    Leave this empty to use your SSH agent or default identity files.
                  </span>
                </div>
              ) : null}
              <label className="ssh-field">
                <span className="ssh-field-label">Description</span>
                <textarea
                  className="ssh-field-input ssh-field-textarea"
                  onChange={(event) => updateField('description', event.target.value)}
                  placeholder="Optional note for teammates or environment details"
                  rows={4}
                  value={formState.description}
                />
              </label>
            </div>
          ) : null}
        </div>
        {errorMessage ? <p className="ssh-config-error">{errorMessage}</p> : null}
        <div className="ssh-config-actions">
          {isEditing ? (
            <button
              className="ssh-config-danger"
              disabled={isBusy}
              onClick={() => void handleDelete()}
              type="button"
            >
              <Trash2 aria-hidden="true" className="ssh-config-danger-icon" />
              {isDeleting ? 'Deleting...' : 'Delete Server'}
            </button>
          ) : null}
          <button
            className="ssh-config-secondary"
            disabled={isBusy}
            onClick={handleCancel}
            type="button"
          >
            Cancel
          </button>
          <button className="ssh-config-primary" disabled={isBusy} type="submit">
            {isSaving ? 'Saving...' : isEditing ? 'Update Server' : 'Save Server'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function TerminalApp(): React.JSX.Element {
  const [isSessionHydrated, setIsSessionHydrated] = useState(false)
  const [tabs, setTabs] = useState<TabRecord[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResultCount, setSearchResultCount] = useState(0)
  const [searchResultIndex, setSearchResultIndex] = useState(-1)
  const [isSshMenuOpen, setIsSshMenuOpen] = useState(false)
  const [isSshBrowserResizing, setIsSshBrowserResizing] = useState(false)
  const [sshBrowserStates, setSshBrowserStates] = useState<SshBrowserStates>({})
  const [sshBrowserWidths, setSshBrowserWidths] = useState<SshBrowserWidths>({})
  const [terminalContextMenu, setTerminalContextMenu] = useState<TerminalContextMenuState | null>(
    null
  )
  const [sshBrowserContextMenu, setSshBrowserContextMenu] =
    useState<SshBrowserContextMenuState | null>(null)
  const [sshDownloadProgress, setSshDownloadProgress] = useState<SshDownloadProgressEvent | null>(
    null
  )
  const [sshUploadProgress, setSshUploadProgress] = useState<SshUploadProgressEvent | null>(null)
  const [isSshConfigDialogOpen, setIsSshConfigDialogOpen] = useState(false)
  const [sshServerBeingEdited, setSshServerBeingEdited] = useState<SshServerConfig | null>(null)
  const [sshServers, setSshServers] = useState<SshServerConfig[]>([])
  const nextTabIdRef = useRef(1)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const workspaceShellRef = useRef<HTMLElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const sshMenuRef = useRef<HTMLDivElement>(null)
  const terminalContextMenuRef = useRef<HTMLDivElement>(null)
  const sshBrowserContextMenuRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<TabRecord[]>([])
  const sshBrowserStatesRef = useRef<SshBrowserStates>({})
  const activeTabIdRef = useRef<string | null>(null)
  const isSearchOpenRef = useRef(false)
  const hostElementsRef = useRef(new Map<string, HTMLDivElement>())
  const runtimesRef = useRef(new Map<string, TerminalRuntime>())
  const searchMatchesRef = useRef<SearchMatch[]>([])
  const searchRefreshTimeoutRef = useRef<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchResultIndexRef = useRef(-1)
  const searchQueryRef = useRef('')
  const sshBrowserResizePointerIdRef = useRef<number | null>(null)
  const sshBrowserResizeTabIdRef = useRef<string | null>(null)
  const sshBrowserRequestIdRef = useRef(0)
  const sshDownloadHideTimeoutRef = useRef<number | null>(null)
  const sshUploadHideTimeoutRef = useRef<number | null>(null)
  const sshCwdSequenceBuffersRef = useRef(new Map<number, string>())
  const terminalToTabRef = useRef(new Map<number, string>())
  const pendingTitlesRef = useRef(new Map<number, string>())
  const pendingInitialTabStateRef = useRef(new Map<string, CreateTabOptions>())
  const initialSessionSnapshotRef = useRef<SessionSnapshot | null | undefined>(undefined)
  const isUnmountingRef = useRef(false)
  const emptyStateCreateQueuedRef = useRef(false)
  const pendingActivationTabIdRef = useRef<string | null>(null)
  const platformClassName =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
      ? 'platform-macos'
      : 'platform-default'

  const updateTab = useCallback((tabId: string, updater: (tab: TabRecord) => TabRecord): void => {
    setTabs((currentTabs) =>
      currentTabs.map((tab) => {
        if (tab.id !== tabId) {
          return tab
        }

        return updater(tab)
      })
    )
  }, [])

  const getTabOutputLinesForSnapshot = useCallback((tab: TabRecord): string[] | undefined => {
    const runtime = runtimesRef.current.get(tab.id)

    if (runtime && !runtime.disposed) {
      return getPersistedTerminalOutputLines(runtime.terminal)
    }

    return clonePersistedOutputLines(tab.outputLines)
  }, [])

  const closeSshBrowserForTab = useCallback((tabId: string | null): void => {
    if (!tabId) {
      return
    }

    setSshBrowserStates((currentStates) => {
      if (!(tabId in currentStates)) {
        return currentStates
      }

      const nextStates = { ...currentStates }
      delete nextStates[tabId]
      return nextStates
    })
  }, [])

  const removeSshBrowserWidthForTab = useCallback((tabId: string | null): void => {
    if (!tabId) {
      return
    }

    setSshBrowserWidths((currentWidths) => {
      if (!(tabId in currentWidths)) {
        return currentWidths
      }

      const nextWidths = { ...currentWidths }
      delete nextWidths[tabId]
      return nextWidths
    })
  }, [])

  const setSshBrowserWidthForTab = useCallback((tabId: string, width: number): void => {
    setSshBrowserWidths((currentWidths) => {
      if (currentWidths[tabId] === width) {
        return currentWidths
      }

      return {
        ...currentWidths,
        [tabId]: width
      }
    })
  }, [])

  const closeSshBrowserContextMenu = useCallback((): void => {
    setSshBrowserContextMenu(null)
  }, [])

  const closeTerminalContextMenu = useCallback((): void => {
    setTerminalContextMenu(null)
  }, [])

  const updateSshBrowserState = useCallback(
    (tabId: string, updater: (browserState: SshBrowserState) => SshBrowserState): void => {
      setSshBrowserStates((currentStates) => {
        const currentState = currentStates[tabId]

        if (!currentState) {
          return currentStates
        }

        const nextState = updater(currentState)

        if (nextState === currentState) {
          return currentStates
        }

        return {
          ...currentStates,
          [tabId]: nextState
        }
      })
    },
    []
  )

  const loadSshDirectory = useCallback(
    (configId: string, path: string | undefined, tabId: string): void => {
      const requestId = sshBrowserRequestIdRef.current + 1
      sshBrowserRequestIdRef.current = requestId

      setSshBrowserStates((currentStates) => {
        const currentState = currentStates[tabId]

        return {
          ...currentStates,
          [tabId]: {
            configId,
            entries: currentState && currentState.configId === configId ? currentState.entries : [],
            errorMessage: null,
            isLoading: true,
            path:
              currentState && currentState.configId === configId
                ? currentState.path
                : (path ?? null),
            requestId,
            tabId
          }
        }
      })

      void window.api.ssh
        .listDirectory(configId, path)
        .then((listing) => {
          setSshBrowserStates((currentStates) => {
            const currentState = currentStates[tabId]

            if (
              !currentState ||
              currentState.configId !== configId ||
              currentState.requestId !== requestId
            ) {
              return currentStates
            }

            return {
              ...currentStates,
              [tabId]: {
                ...currentState,
                entries: listing.entries,
                errorMessage: null,
                isLoading: false,
                path: listing.path
              }
            }
          })

          updateTab(tabId, (tab) => {
            if (tab.restoreState.kind !== 'ssh' || tab.restoreState.browserPath === listing.path) {
              return tab
            }

            return {
              ...tab,
              restoreState: {
                ...tab.restoreState,
                browserPath: listing.path
              }
            }
          })
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)

          setSshBrowserStates((currentStates) => {
            const currentState = currentStates[tabId]

            if (
              !currentState ||
              currentState.configId !== configId ||
              currentState.requestId !== requestId
            ) {
              return currentStates
            }

            return {
              ...currentStates,
              [tabId]: {
                ...currentState,
                errorMessage: message || 'Unable to load this remote directory.',
                isLoading: false
              }
            }
          })
        })
    },
    [updateTab]
  )

  const runSshBrowserMutation = useCallback(
    async (
      browserState: SshBrowserState,
      action: () => Promise<void>,
      failureMessage: string
    ): Promise<void> => {
      updateSshBrowserState(browserState.tabId, (currentState) => ({
        ...currentState,
        errorMessage: null,
        isLoading: true
      }))

      try {
        await action()
        loadSshDirectory(browserState.configId, browserState.path ?? undefined, browserState.tabId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        updateSshBrowserState(browserState.tabId, (currentState) => ({
          ...currentState,
          errorMessage: message || failureMessage,
          isLoading: false
        }))
      }
    },
    [loadSshDirectory, updateSshBrowserState]
  )

  const resetSearchResults = useCallback((): void => {
    setSearchResultCount(0)
    setSearchResultIndex(-1)
  }, [])

  const cancelQueuedSearchRefresh = useCallback((): void => {
    if (searchRefreshTimeoutRef.current === null) {
      return
    }

    window.clearTimeout(searchRefreshTimeoutRef.current)
    searchRefreshTimeoutRef.current = null
  }, [])

  const clearSearchSelection = useCallback((): void => {
    searchMatchesRef.current = []

    for (const runtime of runtimesRef.current.values()) {
      if (runtime.disposed) {
        continue
      }

      runtime.terminal.clearSelection()
    }
  }, [])

  const applyTerminalTheme = useCallback((theme: ITheme): void => {
    for (const runtime of runtimesRef.current.values()) {
      if (runtime.disposed) {
        continue
      }

      runtime.terminal.options.theme = theme
    }
  }, [])

  const focusActiveTerminal = useCallback((): void => {
    const currentActiveTabId = activeTabIdRef.current

    if (!currentActiveTabId) {
      return
    }

    const runtime = runtimesRef.current.get(currentActiveTabId)

    if (!runtime || runtime.disposed) {
      return
    }

    runtime.terminal.focus()
  }, [])

  const refreshSearchMatches = useCallback(
    (tabId: string | null, query: string): boolean => {
      if (!tabId || query === '') {
        clearSearchSelection()
        resetSearchResults()
        return false
      }

      const runtime = runtimesRef.current.get(tabId)

      if (!runtime || runtime.disposed) {
        clearSearchSelection()
        resetSearchResults()
        return false
      }

      const matches = getSearchMatches(runtime.terminal, query)
      searchMatchesRef.current = matches

      if (matches.length === 0) {
        runtime.terminal.clearSelection()
        resetSearchResults()
        return false
      }

      selectSearchMatch(runtime.terminal, matches[0])
      setSearchResultCount(matches.length)
      setSearchResultIndex(0)
      return true
    },
    [clearSearchSelection, resetSearchResults]
  )

  const queueSearchRefresh = useCallback(
    (tabId: string | null = activeTabIdRef.current, delayMs = 0): void => {
      cancelQueuedSearchRefresh()

      if (!isSearchOpenRef.current || searchQueryRef.current === '' || !tabId) {
        return
      }

      searchRefreshTimeoutRef.current = window.setTimeout(() => {
        searchRefreshTimeoutRef.current = null
        refreshSearchMatches(tabId, searchQueryRef.current)
      }, delayMs)
    },
    [cancelQueuedSearchRefresh, refreshSearchMatches]
  )

  const openSearch = useCallback((): void => {
    applyTerminalTheme(searchTerminalTheme)
    setIsSearchOpen(true)
  }, [applyTerminalTheme])

  const closeSearch = useCallback((): void => {
    cancelQueuedSearchRefresh()
    clearSearchSelection()
    applyTerminalTheme(defaultTerminalTheme)
    resetSearchResults()
    setSearchQuery('')
    setIsSearchOpen(false)
    focusActiveTerminal()
  }, [
    applyTerminalTheme,
    cancelQueuedSearchRefresh,
    clearSearchSelection,
    focusActiveTerminal,
    resetSearchResults
  ])

  const findNextMatch = useCallback((): void => {
    const activeTabId = activeTabIdRef.current

    if (!activeTabId || searchQueryRef.current === '') {
      return
    }

    const runtime = runtimesRef.current.get(activeTabId)

    if (!runtime || runtime.disposed) {
      return
    }

    const matches =
      searchMatchesRef.current.length > 0
        ? searchMatchesRef.current
        : getSearchMatches(runtime.terminal, searchQueryRef.current)

    searchMatchesRef.current = matches

    if (matches.length === 0) {
      runtime.terminal.clearSelection()
      resetSearchResults()
      return
    }

    const nextIndex =
      searchResultIndexRef.current === -1 ? 0 : (searchResultIndexRef.current + 1) % matches.length

    selectSearchMatch(runtime.terminal, matches[nextIndex])
    setSearchResultCount(matches.length)
    setSearchResultIndex(nextIndex)
  }, [resetSearchResults])

  const findPreviousMatch = useCallback((): void => {
    const activeTabId = activeTabIdRef.current

    if (!activeTabId || searchQueryRef.current === '') {
      return
    }

    const runtime = runtimesRef.current.get(activeTabId)

    if (!runtime || runtime.disposed) {
      return
    }

    const matches =
      searchMatchesRef.current.length > 0
        ? searchMatchesRef.current
        : getSearchMatches(runtime.terminal, searchQueryRef.current)

    searchMatchesRef.current = matches

    if (matches.length === 0) {
      runtime.terminal.clearSelection()
      resetSearchResults()
      return
    }

    const previousIndex =
      searchResultIndexRef.current === -1
        ? matches.length - 1
        : (searchResultIndexRef.current - 1 + matches.length) % matches.length

    selectSearchMatch(runtime.terminal, matches[previousIndex])
    setSearchResultCount(matches.length)
    setSearchResultIndex(previousIndex)
  }, [resetSearchResults])

  const handleSearchQueryChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const nextQuery = event.target.value

      cancelQueuedSearchRefresh()
      setSearchQuery(nextQuery)

      if (nextQuery === '') {
        clearSearchSelection()
        resetSearchResults()
        return
      }

      refreshSearchMatches(activeTabIdRef.current, nextQuery)
    },
    [cancelQueuedSearchRefresh, clearSearchSelection, refreshSearchMatches, resetSearchResults]
  )

  const syncActiveTabLayout = useCallback((tabId: string | null, shouldFocus = false): void => {
    if (!tabId) {
      return
    }

    window.requestAnimationFrame(() => {
      if (activeTabIdRef.current !== tabId) {
        return
      }

      const runtime = runtimesRef.current.get(tabId)
      const hostElement = hostElementsRef.current.get(tabId)

      if (!runtime || runtime.disposed || !hostElement) {
        return
      }

      runtime.fitAddon.fit()

      if (runtime.terminalId !== null && !runtime.closed) {
        window.api.terminal.resize(runtime.terminalId, runtime.terminal.cols, runtime.terminal.rows)
      }

      if (shouldFocus) {
        runtime.terminal.focus()
      }
    })
  }, [])

  const syncTabStripPosition = useCallback((tabId: string | null): void => {
    if (!tabId) {
      return
    }

    window.requestAnimationFrame(() => {
      const tabStrip = tabStripRef.current

      if (!tabStrip) {
        return
      }

      const activeTabButton = tabStrip.querySelector<HTMLButtonElement>(
        `[aria-controls="panel-${tabId}"]`
      )

      activeTabButton?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      })
    })
  }, [])

  const finalizeTabConnection = useCallback(
    (
      tabId: string,
      terminalId: number,
      title: string,
      preferredTitle?: string,
      shouldActivatePendingTab = false
    ): void => {
      const currentRuntime = runtimesRef.current.get(tabId)

      if (!currentRuntime || currentRuntime.disposed || isUnmountingRef.current) {
        window.api.terminal.kill(terminalId)
        return
      }

      currentRuntime.closed = false
      currentRuntime.terminalId = terminalId
      currentRuntime.terminal.options.disableStdin = false
      terminalToTabRef.current.set(terminalId, tabId)

      updateTab(tabId, (tab) => ({
        ...tab,
        errorMessage: undefined,
        exitCode: undefined,
        reconnectAttempt: undefined,
        status: 'ready',
        terminalId,
        title: preferredTitle ?? pendingTitlesRef.current.get(terminalId) ?? title
      }))
      pendingTitlesRef.current.delete(terminalId)

      if (shouldActivatePendingTab && pendingActivationTabIdRef.current === tabId) {
        pendingActivationTabIdRef.current = null
        setActiveTabId(tabId)
      }

      if (activeTabIdRef.current === tabId) {
        syncActiveTabLayout(tabId, true)
      }
    },
    [syncActiveTabLayout, updateTab]
  )

  const failTabConnection = useCallback(
    (
      tabId: string,
      message: string,
      terminalMessage: string,
      shouldActivatePendingTab = false
    ): void => {
      const currentRuntime = runtimesRef.current.get(tabId)

      pendingInitialTabStateRef.current.delete(tabId)

      if (!currentRuntime || currentRuntime.disposed) {
        return
      }

      currentRuntime.closed = true
      currentRuntime.terminalId = null
      currentRuntime.terminal.options.disableStdin = true
      currentRuntime.terminal.write(`${terminalMessage}: ${message}\r\n`)

      updateTab(tabId, (tab) => ({
        ...tab,
        errorMessage: message,
        exitCode: undefined,
        reconnectAttempt: undefined,
        status: 'closed',
        terminalId: null
      }))

      if (shouldActivatePendingTab && pendingActivationTabIdRef.current === tabId) {
        pendingActivationTabIdRef.current = null
        setActiveTabId(tabId)
      }
    },
    [updateTab]
  )

  const reconnectSshTab = useCallback(
    (tabId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const runtime = runtimesRef.current.get(tabId)

      if (!tab || tab.restoreState.kind !== 'ssh' || tab.status === 'connecting') {
        return
      }

      if (!runtime || runtime.disposed || isUnmountingRef.current) {
        return
      }

      updateTab(tabId, (currentTab) => {
        if (currentTab.restoreState.kind !== 'ssh' || currentTab.status === 'connecting') {
          return currentTab
        }

        return {
          ...currentTab,
          errorMessage: undefined,
          exitCode: undefined,
          reconnectAttempt: 1,
          status: 'connecting',
          terminalId: null
        }
      })

      runtime.closed = true
      runtime.terminalId = null
      runtime.terminal.options.disableStdin = true
      runtime.terminal.write('\r\n[reconnecting...]\r\n')

      void window.api.ssh
        .connect(tab.restoreState.configId, tab.restoreState.cwd)
        .then(({ terminalId, title }) => {
          finalizeTabConnection(tabId, terminalId, title)
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          failTabConnection(tabId, message, 'Unable to reconnect')
        })
    },
    [failTabConnection, finalizeTabConnection, updateTab]
  )

  const maybeReconnectSshTab = useCallback(
    (tabId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const runtime = runtimesRef.current.get(tabId)

      if (
        !tab ||
        tab.restoreState.kind !== 'ssh' ||
        tab.status !== 'closed' ||
        tab.terminalId !== null ||
        !runtime ||
        runtime.disposed ||
        runtime.terminalId !== null
      ) {
        return
      }

      reconnectSshTab(tabId)
    },
    [reconnectSshTab]
  )

  const activateTab = useCallback(
    (tabId: string): void => {
      setActiveTabId(tabId)

      if (activeTabIdRef.current === tabId) {
        maybeReconnectSshTab(tabId)
      }
    },
    [maybeReconnectSshTab]
  )

  const disposeTabRuntime = useCallback((tabId: string, shouldKill: boolean): void => {
    const runtime = runtimesRef.current.get(tabId)

    if (!runtime) {
      return
    }

    runtime.disposed = true
    runtime.disposeInput.dispose()

    if (runtime.terminalId !== null) {
      terminalToTabRef.current.delete(runtime.terminalId)
      pendingTitlesRef.current.delete(runtime.terminalId)
      sshCwdSequenceBuffersRef.current.delete(runtime.terminalId)

      if (shouldKill && !runtime.closed) {
        window.api.terminal.kill(runtime.terminalId)
      }
    }

    runtime.terminal.dispose()
    runtimesRef.current.delete(tabId)
  }, [])

  const createTab = useCallback((options?: CreateTabOptions): void => {
    const tabId = `tab-${nextTabIdRef.current++}`
    const shouldActivateImmediately =
      activeTabIdRef.current === null || tabsRef.current.length === 0
    const nextTitle = options?.title?.trim() || defaultTabTitle
    const restoreState = cloneRestorableTabState(
      options?.restoreState ?? getDefaultRestorableTabState()
    )

    if (options?.createTerminal || options?.terminalCreateOptions || options?.title) {
      pendingInitialTabStateRef.current.set(tabId, {
        createTerminal: options.createTerminal,
        restoreState,
        terminalCreateOptions: options.terminalCreateOptions,
        title: options.title?.trim()
      })
    }

    setTabs((currentTabs) => [
      ...currentTabs,
      {
        id: tabId,
        restoreState,
        status: 'connecting',
        terminalId: null,
        title: nextTitle
      }
    ])

    if (shouldActivateImmediately) {
      pendingActivationTabIdRef.current = null
      setActiveTabId(tabId)
      return
    }

    pendingActivationTabIdRef.current = tabId
  }, [])

  const closeTab = useCallback(
    (tabId: string): void => {
      const currentTabs = tabsRef.current
      const tabIndex = currentTabs.findIndex((tab) => tab.id === tabId)

      if (tabIndex === -1) {
        return
      }

      if (pendingActivationTabIdRef.current === tabId) {
        pendingActivationTabIdRef.current = null
      }

      closeSshBrowserForTab(tabId)
      removeSshBrowserWidthForTab(tabId)
      pendingInitialTabStateRef.current.delete(tabId)
      const remainingTabs = currentTabs.filter((tab) => tab.id !== tabId)

      disposeTabRuntime(tabId, true)
      hostElementsRef.current.delete(tabId)

      setTabs(remainingTabs)

      if (activeTabIdRef.current !== tabId) {
        return
      }

      const nextActiveTabId = remainingTabs[tabIndex]?.id ?? remainingTabs[tabIndex - 1]?.id ?? null

      if (!nextActiveTabId) {
        setActiveTabId(null)
        return
      }

      activateTab(nextActiveTabId)
    },
    [activateTab, closeSshBrowserForTab, disposeTabRuntime, removeSshBrowserWidthForTab]
  )

  const selectAdjacentTab = useCallback(
    (direction: -1 | 1): void => {
      const currentTabs = tabsRef.current
      const currentActiveTabId = activeTabIdRef.current

      if (currentTabs.length < 2 || !currentActiveTabId) {
        return
      }

      const currentIndex = currentTabs.findIndex((tab) => tab.id === currentActiveTabId)

      if (currentIndex === -1) {
        return
      }

      const nextIndex = (currentIndex + direction + currentTabs.length) % currentTabs.length
      const nextTabId = currentTabs[nextIndex]?.id ?? null

      if (!nextTabId) {
        return
      }

      activateTab(nextTabId)
    },
    [activateTab]
  )

  const initializeTab = useCallback(
    (tab: TabRecord, hostElement: HTMLDivElement): void => {
      const tabId = tab.id

      if (runtimesRef.current.has(tabId)) {
        return
      }

      const terminal = new Terminal(terminalOptions)
      const fitAddon = new FitAddon()

      terminal.loadAddon(fitAddon)
      terminal.open(hostElement)
      terminal.options.theme = isSearchOpenRef.current ? searchTerminalTheme : defaultTerminalTheme
      restorePersistedTerminalOutput(terminal, tab.outputLines)

      const runtime: TerminalRuntime = {
        closed: false,
        disposed: false,
        disposeInput: terminal.onData((data) => {
          const currentRuntime = runtimesRef.current.get(tabId)

          if (!currentRuntime || currentRuntime.closed || currentRuntime.terminalId === null) {
            return
          }

          window.api.terminal.write(currentRuntime.terminalId, data)
        }),
        fitAddon,
        terminal,
        terminalId: null
      }

      runtimesRef.current.set(tabId, runtime)

      if (activeTabIdRef.current === tabId) {
        syncActiveTabLayout(tabId, true)
      }

      if (
        activeTabIdRef.current === tabId &&
        isSearchOpenRef.current &&
        searchQueryRef.current !== ''
      ) {
        queueSearchRefresh(tabId, 0)
      }

      const pendingInitialTabState = pendingInitialTabStateRef.current.get(tabId)
      const createTerminalRequest = Promise.resolve().then(() =>
        pendingInitialTabState?.createTerminal
          ? pendingInitialTabState.createTerminal()
          : window.api.terminal.create(pendingInitialTabState?.terminalCreateOptions)
      )

      createTerminalRequest
        .then(({ terminalId, title }) => {
          pendingInitialTabStateRef.current.delete(tabId)
          finalizeTabConnection(tabId, terminalId, title, pendingInitialTabState?.title, true)
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)

          failTabConnection(tabId, message, 'Unable to start shell', true)
        })
    },
    [failTabConnection, finalizeTabConnection, queueSearchRefresh, syncActiveTabLayout]
  )

  const handleTabsReorder = useCallback((nextOrder: TabRecord[]): void => {
    setTabs((currentTabs) => {
      const tabsById = new Map(currentTabs.map((tab) => [tab.id, tab]))

      return nextOrder
        .map((tab) => tabsById.get(tab.id))
        .filter((tab): tab is TabRecord => tab !== undefined)
    })
  }, [])

  useEffect(() => {
    tabsRef.current = tabs

    if (tabs.length > 0) {
      emptyStateCreateQueuedRef.current = false
    }
  }, [tabs])

  useEffect(() => {
    sshBrowserStatesRef.current = sshBrowserStates
  }, [sshBrowserStates])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  useEffect(() => {
    if (!activeTabId) {
      return
    }

    maybeReconnectSshTab(activeTabId)
  }, [activeTabId, maybeReconnectSshTab])

  useEffect(() => {
    const reconnectActiveSshTab = (): void => {
      const currentActiveTabId = activeTabIdRef.current

      if (!currentActiveTabId) {
        return
      }

      maybeReconnectSshTab(currentActiveTabId)
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }

      reconnectActiveSshTab()
    }

    window.addEventListener('focus', reconnectActiveSshTab)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('focus', reconnectActiveSshTab)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [maybeReconnectSshTab])

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen
  }, [isSearchOpen])

  useEffect(() => {
    searchResultIndexRef.current = searchResultIndex
  }, [searchResultIndex])

  useEffect(() => {
    searchQueryRef.current = searchQuery
  }, [searchQuery])

  useEffect(() => {
    let didCancel = false

    void window.api.session
      .load()
      .then((snapshot) => {
        if (didCancel) {
          return
        }

        initialSessionSnapshotRef.current = snapshot

        if (!snapshot || snapshot.tabs.length === 0) {
          setIsSessionHydrated(true)
          return
        }

        const pendingInitialTabState = pendingInitialTabStateRef.current

        for (const tab of snapshot.tabs) {
          pendingInitialTabState.set(tab.id, buildCreateTabOptionsFromSessionTab(tab))
        }

        nextTabIdRef.current = getNextTabSequence(snapshot.tabs)
        setTabs(snapshot.tabs.map((tab) => createTabRecordFromSessionTab(tab)))
        setActiveTabId(snapshot.activeTabId ?? snapshot.tabs[0]?.id ?? null)
      })
      .catch((error) => {
        console.error('Unable to load the previous terminal session.', error)

        if (!didCancel) {
          initialSessionSnapshotRef.current = null
          setIsSessionHydrated(true)
        }
      })

    return () => {
      didCancel = true
    }
  }, [])

  useEffect(() => {
    if (isSessionHydrated) {
      return
    }

    const initialSessionSnapshot = initialSessionSnapshotRef.current

    if (!initialSessionSnapshot || initialSessionSnapshot.tabs.length === 0) {
      return
    }

    if (tabs.length !== initialSessionSnapshot.tabs.length) {
      return
    }

    const didRestoreExpectedTabs = initialSessionSnapshot.tabs.every(
      (tab, index) => tabs[index]?.id === tab.id
    )

    if (!didRestoreExpectedTabs) {
      return
    }

    setIsSessionHydrated(true)
  }, [isSessionHydrated, tabs])

  useEffect(() => {
    if (!isSessionHydrated) {
      return
    }

    const handleBeforeUnload = (): void => {
      void window.api.session
        .save(
          createSessionSnapshot(
            tabsRef.current,
            activeTabIdRef.current,
            getTabOutputLinesForSnapshot
          )
        )
        .catch((error) => {
          console.error('Unable to stage the terminal session before close.', error)
        })
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [getTabOutputLinesForSnapshot, isSessionHydrated])

  useEffect(() => {
    isUnmountingRef.current = false

    if (
      isSessionHydrated &&
      tabs.length === 0 &&
      !isUnmountingRef.current &&
      !emptyStateCreateQueuedRef.current
    ) {
      emptyStateCreateQueuedRef.current = true
      createTab()
    }
  }, [createTab, isSessionHydrated, tabs.length])

  useEffect(() => {
    const workspaceElement = workspaceRef.current

    if (!workspaceElement) {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      syncActiveTabLayout(activeTabIdRef.current)
    })

    resizeObserver.observe(workspaceElement)

    return () => {
      resizeObserver.disconnect()
    }
  }, [syncActiveTabLayout])

  useEffect(() => {
    const disposeData = window.api.terminal.onData((event) => {
      const tabId = terminalToTabRef.current.get(event.terminalId)

      if (!tabId) {
        return
      }

      const runtime = runtimesRef.current.get(tabId)

      if (!runtime || runtime.disposed) {
        return
      }

      const sequenceCarryover = sshCwdSequenceBuffersRef.current.get(event.terminalId) ?? ''
      const { carryover, cleanedData, cwd } = stripSshRemoteCwdSequences(
        event.data,
        sequenceCarryover
      )

      if (carryover !== '') {
        sshCwdSequenceBuffersRef.current.set(event.terminalId, carryover)
      } else {
        sshCwdSequenceBuffersRef.current.delete(event.terminalId)
      }

      if (cleanedData !== '') {
        runtime.terminal.write(cleanedData)
      }

      if (cwd) {
        updateTab(tabId, (tab) => {
          if (tab.restoreState.kind !== 'ssh') {
            return typeof tab.reconnectAttempt === 'number'
              ? {
                  ...tab,
                  reconnectAttempt: undefined
                }
              : tab
          }

          const nextRestoreState =
            tab.restoreState.cwd === cwd
              ? tab.restoreState
              : {
                  ...tab.restoreState,
                  cwd
                }

          if (nextRestoreState === tab.restoreState && tab.reconnectAttempt === undefined) {
            return tab
          }

          return {
            ...tab,
            reconnectAttempt: undefined,
            restoreState: nextRestoreState
          }
        })
      }

      if (
        isSearchOpenRef.current &&
        searchQueryRef.current !== '' &&
        activeTabIdRef.current === tabId
      ) {
        queueSearchRefresh(tabId, searchRefreshDebounceMs)
      }
    })

    const disposeExit = window.api.terminal.onExit((event) => {
      const tabId = terminalToTabRef.current.get(event.terminalId)

      if (!tabId) {
        return
      }

      const runtime = runtimesRef.current.get(tabId)

      terminalToTabRef.current.delete(event.terminalId)
      pendingTitlesRef.current.delete(event.terminalId)
      sshCwdSequenceBuffersRef.current.delete(event.terminalId)

      if (!runtime || runtime.disposed) {
        return
      }

      const shouldReconnectActiveSshTab =
        tabId === activeTabIdRef.current &&
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        (event.exitCode !== 0 || typeof event.signal === 'number')

      runtime.closed = true
      runtime.terminalId = null
      runtime.terminal.options.disableStdin = true
      runtime.terminal.write(`\r\n[process exited with code ${event.exitCode}]\r\n`)

      updateTab(tabId, (tab) => ({
        ...tab,
        exitCode: event.exitCode,
        reconnectAttempt: undefined,
        status: 'closed',
        terminalId: null
      }))

      if (shouldReconnectActiveSshTab) {
        reconnectSshTab(tabId)
      }
    })

    return () => {
      disposeData()
      disposeExit()
    }
  }, [queueSearchRefresh, reconnectSshTab, updateTab])

  useEffect(() => {
    const disposeCwd = window.api.terminal.onCwd((event) => {
      const tabId = terminalToTabRef.current.get(event.terminalId)

      if (!tabId) {
        pendingTitlesRef.current.set(event.terminalId, event.title)
        return
      }

      updateTab(tabId, (tab) => {
        const nextRestoreState =
          tab.restoreState.kind === 'local' && tab.restoreState.cwd !== event.cwd
            ? {
                cwd: event.cwd,
                kind: 'local' as const
              }
            : tab.restoreState

        if (tab.title === event.title && nextRestoreState === tab.restoreState) {
          return tab
        }

        return {
          ...tab,
          restoreState: nextRestoreState,
          title: event.title
        }
      })
    })

    return () => {
      disposeCwd()
    }
  }, [updateTab])

  useEffect(() => {
    const disposeFindRequested = window.api.terminal.onFindRequested(() => {
      if (isSshConfigDialogOpen) {
        return
      }

      const activeElement = document.activeElement
      const isSearchInputTarget = searchInputRef.current === activeElement

      if (
        isEditableElement(activeElement) &&
        !isSearchInputTarget &&
        !isXtermHelperTextarea(activeElement)
      ) {
        return
      }

      openSearch()
    })

    return () => {
      disposeFindRequested()
    }
  }, [isSshConfigDialogOpen, openSearch])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const usesPrimaryModifier = event.metaKey || event.ctrlKey

      if (usesPrimaryModifier && event.key.toLowerCase() === 't') {
        event.preventDefault()
        createTab()
        return
      }

      if (usesPrimaryModifier && event.key.toLowerCase() === 'w') {
        const currentActiveTabId = activeTabIdRef.current

        if (!currentActiveTabId) {
          return
        }

        event.preventDefault()
        closeTab(currentActiveTabId)
        return
      }

      if (usesPrimaryModifier && event.key >= '1' && event.key <= '9') {
        const targetTab = tabsRef.current[Number(event.key) - 1]

        if (!targetTab) {
          return
        }

        event.preventDefault()
        activateTab(targetTab.id)
        return
      }

      if (
        (event.ctrlKey && event.key === 'Tab') ||
        (usesPrimaryModifier && event.shiftKey && event.key === '}')
      ) {
        event.preventDefault()
        selectAdjacentTab(1)
        return
      }

      if (
        (event.ctrlKey && event.shiftKey && event.key === 'Tab') ||
        (usesPrimaryModifier && event.shiftKey && event.key === '{')
      ) {
        event.preventDefault()
        selectAdjacentTab(-1)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [activateTab, closeTab, createTab, selectAdjacentTab])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }

    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }, [activeTabId, isSearchOpen])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }

    if (searchQuery === '') {
      return
    }

    queueSearchRefresh(activeTabId, 0)
  }, [activeTabId, isSearchOpen, queueSearchRefresh, searchQuery])

  useEffect(() => {
    syncActiveTabLayout(activeTabId, true)
    syncTabStripPosition(activeTabId)
  }, [activeTabId, syncActiveTabLayout, syncTabStripPosition, tabs.length])

  useEffect(() => {
    const activeSshBrowserState = activeTabId ? (sshBrowserStates[activeTabId] ?? null) : null

    if (!activeSshBrowserState) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      if (terminalContextMenu) {
        closeTerminalContextMenu()
        return
      }

      if (sshBrowserContextMenu) {
        closeSshBrowserContextMenu()
        return
      }

      closeSshBrowserForTab(activeSshBrowserState.tabId)
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [
    activeTabId,
    closeTerminalContextMenu,
    closeSshBrowserContextMenu,
    closeSshBrowserForTab,
    sshBrowserContextMenu,
    sshBrowserStates,
    terminalContextMenu
  ])

  useEffect(() => {
    if (!terminalContextMenu) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (terminalContextMenuRef.current?.contains(event.target as Node)) {
        return
      }

      closeTerminalContextMenu()
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      closeTerminalContextMenu()
    }

    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('keydown', handleKeyDown, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [closeTerminalContextMenu, terminalContextMenu])

  useEffect(() => {
    if (!terminalContextMenu) {
      return
    }

    if (
      activeTabId !== terminalContextMenu.tabId ||
      !runtimesRef.current.has(terminalContextMenu.tabId)
    ) {
      closeTerminalContextMenu()
    }
  }, [activeTabId, closeTerminalContextMenu, terminalContextMenu, tabs])

  useEffect(() => {
    if (!sshBrowserContextMenu) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (sshBrowserContextMenuRef.current?.contains(event.target as Node)) {
        return
      }

      closeSshBrowserContextMenu()
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      closeSshBrowserContextMenu()
    }

    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('keydown', handleKeyDown, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [closeSshBrowserContextMenu, sshBrowserContextMenu])

  useEffect(() => {
    if (!sshBrowserContextMenu) {
      return
    }

    if (
      activeTabId !== sshBrowserContextMenu.tabId ||
      sshBrowserStates[sshBrowserContextMenu.tabId] === undefined
    ) {
      closeSshBrowserContextMenu()
    }
  }, [activeTabId, closeSshBrowserContextMenu, sshBrowserContextMenu, sshBrowserStates])

  useEffect(() => {
    if (!isSshMenuOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (sshMenuRef.current?.contains(event.target as Node)) {
        return
      }

      setIsSshMenuOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      setIsSshMenuOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('keydown', handleKeyDown, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [isSshMenuOpen])

  useEffect(() => {
    const hostElements = hostElementsRef.current
    const runtimes = runtimesRef.current
    const pendingInitialTabState = pendingInitialTabStateRef.current

    return () => {
      isUnmountingRef.current = true
      cancelQueuedSearchRefresh()

      for (const tabId of Array.from(runtimes.keys())) {
        disposeTabRuntime(tabId, true)
      }

      pendingInitialTabState.clear()
      hostElements.clear()
    }
  }, [cancelQueuedSearchRefresh, disposeTabRuntime])

  const handleTabStripWheel = useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    const tabStrip = tabStripRef.current

    if (!tabStrip || tabStrip.scrollWidth <= tabStrip.clientWidth) {
      return
    }

    const dominantDelta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY

    if (dominantDelta === 0) {
      return
    }

    event.preventDefault()
    tabStrip.scrollBy({ left: dominantDelta })
  }, [])

  const writeDroppedPathsToActiveTerminal = useCallback((paths: string[]): void => {
    if (paths.length === 0) {
      return
    }

    const activeTabId = activeTabIdRef.current

    if (!activeTabId) {
      return
    }

    const runtime = runtimesRef.current.get(activeTabId)

    if (!runtime || runtime.closed || runtime.disposed || runtime.terminalId === null) {
      return
    }

    const escapedPaths = paths.map((path) => quotePathForShell(path))
    window.api.terminal.write(runtime.terminalId, `${escapedPaths.join(' ')} `)
    runtime.terminal.focus()
  }, [])

  const writeTerminalStatusToTab = useCallback((tabId: string, message: string): void => {
    const runtime = runtimesRef.current.get(tabId)

    if (!runtime || runtime.closed || runtime.disposed) {
      return
    }

    runtime.terminal.write(`\r\n${message}\r\n`)
    runtime.terminal.focus()
  }, [])

  const uploadDroppedPathsToActiveSshTab = useCallback(
    (paths: string[]): void => {
      if (paths.length === 0) {
        return
      }

      const currentActiveTabId = activeTabIdRef.current

      if (!currentActiveTabId) {
        return
      }

      const activeTab = tabsRef.current.find((tab) => tab.id === currentActiveTabId)

      if (!activeTab || activeTab.restoreState.kind !== 'ssh') {
        return
      }

      const browserState = sshBrowserStatesRef.current[currentActiveTabId]
      const targetPath = (activeTab.restoreState.cwd ?? '').trim()

      if (targetPath === '') {
        const message = 'Unable to upload: remote working directory is not available yet.'

        if (browserState) {
          updateSshBrowserState(currentActiveTabId, (currentState) => ({
            ...currentState,
            errorMessage: message,
            isLoading: false
          }))
        }

        writeTerminalStatusToTab(currentActiveTabId, message)
        return
      }

      if (browserState?.path === targetPath) {
        updateSshBrowserState(currentActiveTabId, (currentState) => ({
          ...currentState,
          errorMessage: null,
          isLoading: true
        }))
      }

      void window.api.ssh
        .uploadPaths(activeTab.restoreState.configId, targetPath, paths)
        .then(() => {
          const nextBrowserState = sshBrowserStatesRef.current[currentActiveTabId]

          if (nextBrowserState?.path === targetPath) {
            loadSshDirectory(nextBrowserState.configId, targetPath, currentActiveTabId)
          } else if (browserState?.path === targetPath) {
            updateSshBrowserState(currentActiveTabId, (currentState) => ({
              ...currentState,
              errorMessage: null,
              isLoading: false
            }))
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          const fallbackMessage = message || 'Unable to upload the dropped files.'

          if (browserState?.path === targetPath) {
            updateSshBrowserState(currentActiveTabId, (currentState) => ({
              ...currentState,
              errorMessage: fallbackMessage,
              isLoading: false
            }))
          }

          writeTerminalStatusToTab(currentActiveTabId, `Upload failed: ${fallbackMessage}`)
        })
    },
    [loadSshDirectory, updateSshBrowserState, writeTerminalStatusToTab]
  )

  const handleWorkspaceDragOver = useCallback((event: React.DragEvent<HTMLElement>): void => {
    if (!shouldHandleFileDrop(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleWorkspaceDrop = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (!shouldHandleFileDrop(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const droppedFiles = new Set<File>()

      for (const file of Array.from(event.dataTransfer.files)) {
        droppedFiles.add(file)
      }

      for (const item of Array.from(event.dataTransfer.items)) {
        if (item.kind !== 'file') {
          continue
        }

        const file = item.getAsFile()

        if (file) {
          droppedFiles.add(file)
        }
      }

      const droppedPaths = new Set<string>()

      for (const file of droppedFiles) {
        const path = window.api.webUtils.getPathForFile(file)

        if (path) {
          droppedPaths.add(path)
        }
      }

      for (const path of getPathsFromUriList(event.dataTransfer)) {
        droppedPaths.add(path)
      }

      const nextDroppedPaths = Array.from(droppedPaths)
      const currentActiveTabId = activeTabIdRef.current
      const activeTab = currentActiveTabId
        ? tabsRef.current.find((tab) => tab.id === currentActiveTabId)
        : null

      if (activeTab?.restoreState.kind === 'ssh') {
        uploadDroppedPathsToActiveSshTab(nextDroppedPaths)
        return
      }

      writeDroppedPathsToActiveTerminal(nextDroppedPaths)
    },
    [uploadDroppedPathsToActiveSshTab, writeDroppedPathsToActiveTerminal]
  )

  const handleOpenSshConfigDialog = useCallback((): void => {
    setIsSshMenuOpen(false)
    setSshServerBeingEdited(null)
    setIsSshConfigDialogOpen(true)
  }, [])

  const handleEditSshServer = useCallback((server: SshServerConfig): void => {
    setIsSshMenuOpen(false)
    setSshServerBeingEdited(server)
    setIsSshConfigDialogOpen(true)
  }, [])

  const handleCloseSshConfigDialog = useCallback((): void => {
    setIsSshConfigDialogOpen(false)
    setSshServerBeingEdited(null)
  }, [])

  const handleConnectToSshServer = useCallback(
    (server: SshServerConfig): void => {
      setIsSshMenuOpen(false)
      createTab({
        createTerminal: () => window.api.ssh.connect(server.id),
        restoreState: {
          configId: server.id,
          kind: 'ssh'
        },
        title: server.name
      })
    },
    [createTab]
  )

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeLocalTabCwd =
    activeTab?.restoreState.kind === 'local' ? (activeTab.restoreState.cwd ?? null) : null
  const activeSshConfigId =
    activeTab?.restoreState.kind === 'ssh' ? activeTab.restoreState.configId : null
  const activeSshCwd =
    activeTab?.restoreState.kind === 'ssh' ? (activeTab.restoreState.cwd ?? null) : null
  const activeSshBrowserPath =
    activeTab?.restoreState.kind === 'ssh' ? (activeTab.restoreState.browserPath ?? null) : null
  const activeSshTabId = activeTab?.restoreState.kind === 'ssh' ? activeTab.id : null
  const activeSshBrowserState = activeTabId ? (sshBrowserStates[activeTabId] ?? null) : null
  const activeSshBrowserId = activeSshBrowserState
    ? `ssh-browser-${activeSshBrowserState.tabId}`
    : undefined
  const activeSshBrowserWidth = activeTabId
    ? (sshBrowserWidths[activeTabId] ?? defaultSshBrowserWidth)
    : defaultSshBrowserWidth
  const mountedSshBrowserTabs = tabs.filter((tab) => sshBrowserStates[tab.id] !== undefined)
  const hasMountedSshBrowsers = mountedSshBrowserTabs.length > 0
  const sshBrowserWorkspaceStyle = activeSshBrowserState
    ? ({ '--ssh-browser-width': `${activeSshBrowserWidth}px` } as CSSProperties)
    : undefined
  const openCurrentFolderPath =
    activeSshBrowserState?.path ?? activeSshBrowserPath ?? activeSshCwd ?? null
  const openCurrentFolderTitle = activeSshConfigId
    ? openCurrentFolderPath
      ? `Browse ${openCurrentFolderPath}`
      : 'Browse remote files'
    : activeLocalTabCwd
      ? `Open ${activeLocalTabCwd}`
      : 'Current folder is not available yet'

  const handleOpenCurrentFolder = useCallback((): void => {
    if (activeSshConfigId && activeSshTabId) {
      if (activeSshBrowserState) {
        closeSshBrowserForTab(activeSshTabId)
        return
      }

      setIsSshMenuOpen(false)
      loadSshDirectory(activeSshConfigId, openCurrentFolderPath ?? undefined, activeSshTabId)
      return
    }

    if (!activeLocalTabCwd) {
      return
    }

    void window.api.shell.openPath(activeLocalTabCwd).catch((error) => {
      console.error(`Unable to open folder "${activeLocalTabCwd}".`, error)
    })
  }, [
    activeLocalTabCwd,
    activeSshConfigId,
    activeSshTabId,
    activeSshBrowserState,
    closeSshBrowserForTab,
    loadSshDirectory,
    openCurrentFolderPath
  ])

  const handleOpenSshBrowserDirectory = useCallback(
    (browserState: SshBrowserState, entry: SshRemoteDirectoryEntry): void => {
      if (!browserState.path || !entry.isDirectory) {
        return
      }

      loadSshDirectory(
        browserState.configId,
        joinRemoteDirectoryPath(browserState.path, entry.name),
        browserState.tabId
      )
    },
    [loadSshDirectory]
  )

  const handleOpenSshBrowserParent = useCallback(
    (browserState: SshBrowserState): void => {
      if (!browserState.path) {
        return
      }

      const parentPath = getRemoteDirectoryParentPath(browserState.path)

      if (!parentPath) {
        return
      }

      loadSshDirectory(browserState.configId, parentPath, browserState.tabId)
    },
    [loadSshDirectory]
  )

  const handleRefreshSshBrowser = useCallback(
    (browserState: SshBrowserState): void => {
      loadSshDirectory(browserState.configId, browserState.path ?? undefined, browserState.tabId)
    },
    [loadSshDirectory]
  )

  const handleOpenSshBrowserContextMenu = useCallback(
    (
      event: React.MouseEvent<HTMLElement>,
      browserState: SshBrowserState,
      entry: SshRemoteDirectoryEntry
    ): void => {
      if (!browserState.path || browserState.isLoading) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const menuPadding = 12
      const menuWidth = 184
      const menuHeight = 156
      const maxX = Math.max(menuPadding, window.innerWidth - menuWidth - menuPadding)
      const maxY = Math.max(menuPadding, window.innerHeight - menuHeight - menuPadding)

      setSshBrowserContextMenu({
        entry,
        tabId: browserState.tabId,
        x: Math.min(Math.max(event.clientX, menuPadding), maxX),
        y: Math.min(Math.max(event.clientY, menuPadding), maxY)
      })
    },
    []
  )

  const handleOpenTerminalContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, tabId: string): void => {
      const runtime = runtimesRef.current.get(tabId)

      if (!runtime || runtime.disposed) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const selectionText = runtime.terminal.getSelection()
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const quickDownloadAction = tab ? getTerminalQuickDownloadAction(tab, selectionText) : null
      const quickExtractAction = tab ? getTerminalQuickExtractAction(tab, selectionText) : null
      const quickActionCount =
        Number(Boolean(quickDownloadAction)) + Number(Boolean(quickExtractAction))

      const menuPadding = 12
      const menuWidth = 296
      const menuHeight = 320 + quickActionCount * 44
      const maxX = Math.max(menuPadding, window.innerWidth - menuWidth - menuPadding)
      const maxY = Math.max(menuPadding, window.innerHeight - menuHeight - menuPadding)

      setTerminalContextMenu({
        quickDownloadAction,
        quickExtractAction,
        selectionText,
        tabId,
        x: Math.min(Math.max(event.clientX, menuPadding), maxX),
        y: Math.min(Math.max(event.clientY, menuPadding), maxY)
      })
    },
    []
  )

  const handleCopyTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = runtimesRef.current.get(currentMenu.tabId)

    if (!runtime || runtime.disposed || !runtime.terminal.hasSelection()) {
      closeTerminalContextMenu()
      return
    }

    window.api.clipboard.writeText(runtime.terminal.getSelection())
    runtime.terminal.focus()
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, terminalContextMenu])

  const handleSearchTerminalSelectionWithGoogle = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = runtimesRef.current.get(currentMenu.tabId)
    const selectionText = currentMenu.selectionText.trim()

    if (!runtime || runtime.disposed || selectionText === '') {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.focus()
    void window.api.shell
      .openExternal(`https://www.google.com/search?q=${encodeURIComponent(selectionText)}`)
      .catch((error) => {
        console.error('Unable to open Google search.', error)
      })
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, terminalContextMenu])

  const handleDownloadTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu?.quickDownloadAction) {
      closeTerminalContextMenu()
      return
    }

    const runtime = runtimesRef.current.get(currentMenu.tabId)

    if (!runtime || runtime.disposed) {
      closeTerminalContextMenu()
      return
    }

    const { configId, remotePath } = currentMenu.quickDownloadAction

    runtime.terminal.focus()

    void window.api.ssh.downloadPath(configId, remotePath, false).catch((error) => {
      console.error('Unable to download selected remote file.', error)
    })

    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, terminalContextMenu])

  const handleExtractTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu?.quickExtractAction) {
      closeTerminalContextMenu()
      return
    }

    const runtime = runtimesRef.current.get(currentMenu.tabId)

    if (!runtime || runtime.closed || runtime.disposed || runtime.terminalId === null) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.clearSelection()
    runtime.terminal.focus()
    runtime.terminal.input(`${currentMenu.quickExtractAction.command}\r`)
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, terminalContextMenu])

  const handlePasteIntoTerminal = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = runtimesRef.current.get(currentMenu.tabId)

    if (!runtime || runtime.disposed) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.focus()
    runtime.terminal.paste(window.api.clipboard.readText())
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, terminalContextMenu])

  const handleSelectAllTerminalContent = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = runtimesRef.current.get(currentMenu.tabId)

    if (!runtime || runtime.disposed) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.focus()
    runtime.terminal.selectAll()
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, terminalContextMenu])

  const handleClearTerminalContent = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = runtimesRef.current.get(currentMenu.tabId)

    if (!runtime || runtime.disposed) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.focus()
    runtime.terminal.clear()

    if (activeTabIdRef.current === currentMenu.tabId && isSearchOpenRef.current) {
      queueSearchRefresh(currentMenu.tabId, 0)
    }

    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, queueSearchRefresh, terminalContextMenu])

  const handleDeleteSshBrowserEntry = useCallback(
    (browserState: SshBrowserState, entry: SshRemoteDirectoryEntry): void => {
      if (!browserState.path || browserState.isLoading) {
        return
      }

      closeSshBrowserContextMenu()

      const entryLabel = entry.isDirectory ? 'folder' : 'file'
      const shouldDelete = window.confirm(`Delete ${entryLabel} "${entry.name}"?`)

      if (!shouldDelete) {
        return
      }

      const remotePath = joinRemoteDirectoryPath(browserState.path, entry.name)

      void runSshBrowserMutation(
        browserState,
        () => window.api.ssh.deletePath(browserState.configId, remotePath, entry.isDirectory),
        'Unable to delete this remote entry.'
      )
    },
    [closeSshBrowserContextMenu, runSshBrowserMutation]
  )

  const handleDownloadSshBrowserEntry = useCallback(
    (browserState: SshBrowserState, entry: SshRemoteDirectoryEntry): void => {
      if (!browserState.path || browserState.isLoading) {
        return
      }

      closeSshBrowserContextMenu()
      updateSshBrowserState(browserState.tabId, (currentState) => ({
        ...currentState,
        errorMessage: null
      }))

      const remotePath = joinRemoteDirectoryPath(browserState.path, entry.name)

      void window.api.ssh
        .downloadPath(browserState.configId, remotePath, entry.isDirectory)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)

          updateSshBrowserState(browserState.tabId, (currentState) => ({
            ...currentState,
            errorMessage: message || 'Unable to download this remote entry.'
          }))
        })
    },
    [closeSshBrowserContextMenu, updateSshBrowserState]
  )

  const handleRenameSshBrowserEntry = useCallback(
    (browserState: SshBrowserState, entry: SshRemoteDirectoryEntry): void => {
      if (!browserState.path || browserState.isLoading) {
        return
      }

      closeSshBrowserContextMenu()

      const nextNameInput = window.prompt('Rename to:', entry.name)

      if (nextNameInput === null) {
        return
      }

      const nextName = nextNameInput.trim()

      if (nextName === '') {
        updateSshBrowserState(browserState.tabId, (currentState) => ({
          ...currentState,
          errorMessage: 'Enter a name before renaming this remote entry.'
        }))
        return
      }

      if (nextName.includes('/')) {
        updateSshBrowserState(browserState.tabId, (currentState) => ({
          ...currentState,
          errorMessage: 'Remote entry names cannot include "/".'
        }))
        return
      }

      if (nextName === entry.name) {
        return
      }

      const remotePath = joinRemoteDirectoryPath(browserState.path, entry.name)
      const nextPath = joinRemoteDirectoryPath(browserState.path, nextName)

      void runSshBrowserMutation(
        browserState,
        () => window.api.ssh.renamePath(browserState.configId, remotePath, nextPath),
        'Unable to rename this remote entry.'
      )
    },
    [closeSshBrowserContextMenu, runSshBrowserMutation, updateSshBrowserState]
  )

  const handleSshBrowserResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (
        !activeSshBrowserState ||
        event.button !== 0 ||
        window.innerWidth <= sshBrowserOverlayBreakpointPx
      ) {
        return
      }

      const workspaceShellElement = workspaceShellRef.current

      if (!workspaceShellElement) {
        return
      }

      const workspaceRect = workspaceShellElement.getBoundingClientRect()

      sshBrowserResizePointerIdRef.current = event.pointerId
      sshBrowserResizeTabIdRef.current = activeSshBrowserState.tabId
      setIsSshBrowserResizing(true)
      setSshBrowserWidthForTab(
        activeSshBrowserState.tabId,
        clampSshBrowserWidth(workspaceRect.right - event.clientX, workspaceRect.width)
      )
      event.preventDefault()
    },
    [activeSshBrowserState, setSshBrowserWidthForTab]
  )

  const handleSshBrowserResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!activeSshBrowserState) {
        return
      }

      const workspaceShellElement = workspaceShellRef.current

      if (!workspaceShellElement) {
        return
      }

      const workspaceWidth = workspaceShellElement.clientWidth
      let nextWidth: number | null = null

      if (event.key === 'ArrowLeft') {
        nextWidth = activeSshBrowserWidth + 24
      } else if (event.key === 'ArrowRight') {
        nextWidth = activeSshBrowserWidth - 24
      } else if (event.key === 'Home') {
        nextWidth = minSshBrowserWidth
      } else if (event.key === 'End') {
        nextWidth = maxSshBrowserWidth
      }

      if (nextWidth === null) {
        return
      }

      event.preventDefault()
      setSshBrowserWidthForTab(
        activeSshBrowserState.tabId,
        clampSshBrowserWidth(nextWidth, workspaceWidth)
      )
    },
    [activeSshBrowserState, activeSshBrowserWidth, setSshBrowserWidthForTab]
  )

  useEffect(() => {
    if (!isSshBrowserResizing) {
      return
    }

    const handlePointerMove = (event: PointerEvent): void => {
      if (sshBrowserResizePointerIdRef.current !== event.pointerId) {
        return
      }

      const workspaceShellElement = workspaceShellRef.current

      if (!workspaceShellElement) {
        return
      }

      const workspaceRect = workspaceShellElement.getBoundingClientRect()
      const resizeTabId = sshBrowserResizeTabIdRef.current

      if (!resizeTabId) {
        return
      }

      setSshBrowserWidthForTab(
        resizeTabId,
        clampSshBrowserWidth(workspaceRect.right - event.clientX, workspaceRect.width)
      )
    }

    const stopResizing = (event: PointerEvent): void => {
      if (sshBrowserResizePointerIdRef.current !== event.pointerId) {
        return
      }

      sshBrowserResizePointerIdRef.current = null
      sshBrowserResizeTabIdRef.current = null
      setIsSshBrowserResizing(false)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }
  }, [isSshBrowserResizing, setSshBrowserWidthForTab])

  useEffect(() => {
    if (activeSshBrowserState || !isSshBrowserResizing) {
      return
    }

    sshBrowserResizePointerIdRef.current = null
    sshBrowserResizeTabIdRef.current = null
    setIsSshBrowserResizing(false)
  }, [activeSshBrowserState, isSshBrowserResizing])

  useEffect(() => {
    let didCancel = false

    void window.api.ssh
      .listConfigs()
      .then((configs) => {
        if (didCancel) {
          return
        }

        setSshServers((currentConfigs) => upsertSshServers(currentConfigs, configs))
      })
      .catch((error) => {
        console.error('Unable to load saved SSH servers.', error)
      })

    return () => {
      didCancel = true
    }
  }, [])

  useEffect(() => {
    const disposeConfigAdded = window.api.ssh.onConfigAdded((config) => {
      setSshServers((currentConfigs) => upsertSshServers(currentConfigs, [config]))
      setIsSshMenuOpen(false)
    })

    return () => {
      disposeConfigAdded()
    }
  }, [])

  useEffect(() => {
    const disposeConfigDeleted = window.api.ssh.onConfigDeleted((configId) => {
      setSshServers((currentConfigs) => removeSshServer(currentConfigs, configId))
      setIsSshMenuOpen(false)
    })

    return () => {
      disposeConfigDeleted()
    }
  }, [])

  useEffect(() => {
    const disposeDownloadProgress = window.api.ssh.onDownloadProgress((event) => {
      if (sshDownloadHideTimeoutRef.current !== null) {
        window.clearTimeout(sshDownloadHideTimeoutRef.current)
        sshDownloadHideTimeoutRef.current = null
      }

      if (event.status === 'failed') {
        setSshDownloadProgress((currentProgress) =>
          currentProgress?.downloadId === event.downloadId ? null : currentProgress
        )
        return
      }

      setSshDownloadProgress(event)

      if (event.status === 'completed') {
        sshDownloadHideTimeoutRef.current = window.setTimeout(() => {
          setSshDownloadProgress((currentProgress) =>
            currentProgress?.downloadId === event.downloadId ? null : currentProgress
          )
          sshDownloadHideTimeoutRef.current = null
        }, 2000)
      }
    })

    return () => {
      if (sshDownloadHideTimeoutRef.current !== null) {
        window.clearTimeout(sshDownloadHideTimeoutRef.current)
        sshDownloadHideTimeoutRef.current = null
      }

      disposeDownloadProgress()
    }
  }, [])

  useEffect(() => {
    const disposeUploadProgress = window.api.ssh.onUploadProgress((event) => {
      if (sshUploadHideTimeoutRef.current !== null) {
        window.clearTimeout(sshUploadHideTimeoutRef.current)
        sshUploadHideTimeoutRef.current = null
      }

      if (event.status === 'failed') {
        setSshUploadProgress((currentProgress) =>
          currentProgress?.uploadId === event.uploadId ? null : currentProgress
        )
        return
      }

      setSshUploadProgress(event)

      if (event.status === 'completed') {
        sshUploadHideTimeoutRef.current = window.setTimeout(() => {
          setSshUploadProgress((currentProgress) =>
            currentProgress?.uploadId === event.uploadId ? null : currentProgress
          )
          sshUploadHideTimeoutRef.current = null
        }, 2000)
      }
    })

    return () => {
      if (sshUploadHideTimeoutRef.current !== null) {
        window.clearTimeout(sshUploadHideTimeoutRef.current)
        sshUploadHideTimeoutRef.current = null
      }

      disposeUploadProgress()
    }
  }, [])

  useEffect(() => {
    const preventWindowFileDrop = (event: DragEvent): void => {
      if (!shouldHandleFileDrop(event.dataTransfer)) {
        return
      }

      event.preventDefault()
    }

    window.addEventListener('dragover', preventWindowFileDrop, { capture: true })
    window.addEventListener('drop', preventWindowFileDrop, { capture: true })

    return () => {
      window.removeEventListener('dragover', preventWindowFileDrop, { capture: true })
      window.removeEventListener('drop', preventWindowFileDrop, { capture: true })
    }
  }, [])

  const searchStatusText =
    searchQuery === ''
      ? 'Type to search'
      : searchResultCount === 0
        ? 'No matches'
        : searchResultIndex >= 0
          ? `${searchResultIndex + 1}/${searchResultCount}`
          : `${searchResultCount} matches`
  const downloadProgressPercent = sshDownloadProgress ? Math.round(sshDownloadProgress.percent) : 0
  const downloadProgressOffset =
    uploadProgressCircleCircumference -
    (uploadProgressCircleCircumference * downloadProgressPercent) / 100
  const isDownloadCompleted = sshDownloadProgress?.status === 'completed'
  const downloadProgressRingStyle: CSSProperties | undefined = sshDownloadProgress
    ? {
        strokeDasharray: uploadProgressCircleCircumference,
        strokeDashoffset: downloadProgressOffset
      }
    : undefined
  const uploadProgressPercent = sshUploadProgress ? Math.round(sshUploadProgress.percent) : 0
  const uploadProgressOffset =
    uploadProgressCircleCircumference -
    (uploadProgressCircleCircumference * uploadProgressPercent) / 100
  const isUploadCompleted = sshUploadProgress?.status === 'completed'
  const uploadProgressRingStyle: CSSProperties | undefined = sshUploadProgress
    ? {
        strokeDasharray: uploadProgressCircleCircumference,
        strokeDashoffset: uploadProgressOffset
      }
    : undefined

  return (
    <main className={`app-shell ${platformClassName}`}>
      <header className="window-titlebar">
        <div className="window-brand">
          <span className="window-title">Terminal</span>
          <span className="window-subtitle">
            {tabs.length} tab{tabs.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="tab-strip-shell" onWheel={handleTabStripWheel}>
          <Reorder.Group
            as="div"
            aria-label="Terminal tabs"
            axis="x"
            className="tab-strip"
            layoutScroll
            onReorder={handleTabsReorder}
            ref={tabStripRef}
            role="tablist"
            values={tabs}
          >
            {tabs.map((tab, index) => {
              const isActive = tab.id === activeTabId

              return (
                <ReorderableTab
                  closeTab={closeTab}
                  index={index}
                  isActive={isActive}
                  key={tab.id}
                  onActivateTab={activateTab}
                  tab={tab}
                />
              )
            })}
          </Reorder.Group>
          <div aria-hidden="true" className="tab-strip-fill" />
        </div>
        <div aria-hidden="true" className="window-drag-spacer" />
        <div className="tab-actions">
          {sshDownloadProgress ? (
            <div
              aria-label={
                isDownloadCompleted
                  ? `Download to ${sshDownloadProgress.targetPath} completed`
                  : `Download progress ${downloadProgressPercent}%`
              }
              className={`window-upload-progress${isDownloadCompleted ? ' is-complete' : ''}`}
              title={
                isDownloadCompleted
                  ? `Download to ${sshDownloadProgress.targetPath} completed`
                  : `Downloading to ${sshDownloadProgress.targetPath}: ${downloadProgressPercent}%`
              }
            >
              {isDownloadCompleted ? (
                <Check aria-hidden="true" className="window-upload-success-icon" />
              ) : (
                <svg aria-hidden="true" className="window-upload-progress-ring" viewBox="0 0 40 40">
                  <circle className="window-upload-progress-track" cx="20" cy="20" r="16" />
                  <circle
                    className="window-upload-progress-value"
                    cx="20"
                    cy="20"
                    r="16"
                    style={downloadProgressRingStyle}
                  />
                </svg>
              )}
            </div>
          ) : null}
          {sshUploadProgress ? (
            <div
              aria-label={
                isUploadCompleted
                  ? `Upload to ${sshUploadProgress.targetPath} completed`
                  : `Upload progress ${uploadProgressPercent}%`
              }
              className={`window-upload-progress${isUploadCompleted ? ' is-complete' : ''}`}
              title={
                isUploadCompleted
                  ? `Upload to ${sshUploadProgress.targetPath} completed`
                  : `Uploading to ${sshUploadProgress.targetPath}: ${uploadProgressPercent}%`
              }
            >
              {isUploadCompleted ? (
                <Check aria-hidden="true" className="window-upload-success-icon" />
              ) : (
                <svg aria-hidden="true" className="window-upload-progress-ring" viewBox="0 0 40 40">
                  <circle className="window-upload-progress-track" cx="20" cy="20" r="16" />
                  <circle
                    className="window-upload-progress-value"
                    cx="20"
                    cy="20"
                    r="16"
                    style={uploadProgressRingStyle}
                  />
                </svg>
              )}
            </div>
          ) : null}
          <button
            aria-label="Create a new tab"
            className="tab-action"
            onClick={() => createTab()}
            title="New tab"
            type="button"
          >
            <Plus aria-hidden="true" className="tab-action-icon" />
          </button>
          <button
            aria-controls={activeSshConfigId ? activeSshBrowserId : undefined}
            aria-expanded={activeSshConfigId ? Boolean(activeSshBrowserState) : undefined}
            aria-haspopup={activeSshConfigId ? 'dialog' : undefined}
            aria-label="Open current folder"
            className={`tab-action${activeSshBrowserState ? ' is-open' : ''}`}
            disabled={!activeLocalTabCwd && !activeSshConfigId}
            onClick={handleOpenCurrentFolder}
            title={openCurrentFolderTitle}
            type="button"
          >
            <FolderOpen aria-hidden="true" className="tab-action-icon" />
          </button>
          <div className="tab-action-menu-shell" ref={sshMenuRef}>
            <button
              aria-controls="ssh-menu"
              aria-expanded={isSshMenuOpen}
              aria-haspopup="menu"
              aria-label="Open SSH menu"
              className={`tab-action${isSshMenuOpen ? ' is-open' : ''}`}
              onClick={() => setIsSshMenuOpen((currentValue) => !currentValue)}
              title="SSH"
              type="button"
            >
              <SshIcon />
            </button>
            {isSshMenuOpen ? (
              <div className="tab-action-menu" id="ssh-menu" role="menu">
                <button
                  className="tab-action-menu-item"
                  onClick={handleOpenSshConfigDialog}
                  role="menuitem"
                  type="button"
                >
                  <HardDrive aria-hidden="true" className="tab-action-menu-icon" />
                  Add SSH Server
                </button>
                {sshServers.length > 0 ? (
                  <>
                    <div aria-hidden="true" className="tab-action-menu-divider" />
                    {sshServers.map((server) => (
                      <div className="tab-action-menu-saved-row" key={server.id} role="none">
                        <button
                          className="tab-action-menu-saved"
                          onClick={() => handleConnectToSshServer(server)}
                          role="menuitem"
                          type="button"
                        >
                          <span aria-hidden="true" className="tab-action-menu-saved-icon-shell">
                            <SshServerIconGlyph
                              className="tab-action-menu-saved-icon"
                              icon={server.icon}
                            />
                          </span>
                          <span className="tab-action-menu-saved-copy">
                            <span className="tab-action-menu-saved-label">{server.name}</span>
                            <span className="tab-action-menu-saved-meta">
                              {formatSshTarget(server)}
                            </span>
                          </span>
                        </button>
                        <button
                          aria-label={`Edit ${server.name}`}
                          className="tab-action-menu-edit"
                          onClick={() => handleEditSshServer(server)}
                          role="menuitem"
                          title="Edit SSH server"
                          type="button"
                        >
                          <Pencil aria-hidden="true" className="tab-action-menu-edit-icon" />
                        </button>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <section
        className={`terminal-workspace${activeSshBrowserState ? ' has-browser' : ''}${isSshBrowserResizing ? ' is-resizing' : ''}`}
        onDragOver={handleWorkspaceDragOver}
        onDrop={handleWorkspaceDrop}
        ref={workspaceShellRef}
        style={sshBrowserWorkspaceStyle}
      >
        <div className="terminal-stage" ref={workspaceRef}>
          {isSearchOpen ? (
            <div className="terminal-search" role="search">
              <label className="terminal-search-field">
                <Search aria-hidden="true" className="terminal-search-icon" />
                <input
                  aria-label="Search current terminal"
                  className="terminal-search-input"
                  onChange={handleSearchQueryChange}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      closeSearch()
                      return
                    }

                    if (event.key === 'Enter') {
                      event.preventDefault()

                      if (event.shiftKey) {
                        findPreviousMatch()
                        return
                      }

                      findNextMatch()
                    }
                  }}
                  placeholder="Find in terminal"
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                />
              </label>
              <span
                aria-live="polite"
                className={`terminal-search-status${searchQuery !== '' && searchResultCount === 0 ? ' is-empty' : ''}`}
              >
                {searchStatusText}
              </span>
              <button
                aria-label="Previous match"
                className="terminal-search-button"
                disabled={searchQuery === ''}
                onClick={findPreviousMatch}
                title="Previous match"
                type="button"
              >
                <ChevronUp aria-hidden="true" className="terminal-search-button-icon" />
              </button>
              <button
                aria-label="Next match"
                className="terminal-search-button"
                disabled={searchQuery === ''}
                onClick={findNextMatch}
                title="Next match"
                type="button"
              >
                <ChevronDown aria-hidden="true" className="terminal-search-button-icon" />
              </button>
              <button
                aria-label="Close search"
                className="terminal-search-button"
                onClick={closeSearch}
                title="Close search"
                type="button"
              >
                <X aria-hidden="true" className="terminal-search-button-icon" />
              </button>
            </div>
          ) : null}
          {tabs.map((tab) => (
            <div
              aria-hidden={tab.id !== activeTabId}
              className={`terminal-screen${tab.id === activeTabId ? ' is-active' : ''}`}
              id={`panel-${tab.id}`}
              key={tab.id}
              onContextMenu={(event) => handleOpenTerminalContextMenu(event, tab.id)}
              ref={(node) => {
                if (!node) {
                  hostElementsRef.current.delete(tab.id)
                  return
                }

                hostElementsRef.current.set(tab.id, node)
                initializeTab(tab, node)
              }}
              role="tabpanel"
            />
          ))}
        </div>
        {terminalContextMenu ? (
          <div
            className="terminal-context-menu"
            ref={terminalContextMenuRef}
            role="menu"
            style={{
              left: terminalContextMenu.x,
              top: terminalContextMenu.y
            }}
          >
            {terminalContextMenu.quickDownloadAction || terminalContextMenu.quickExtractAction ? (
              <>
                {terminalContextMenu.quickDownloadAction ? (
                  <button
                    className="terminal-context-menu-item"
                    onClick={handleDownloadTerminalSelection}
                    role="menuitem"
                    title="Download"
                    type="button"
                  >
                    <span className="terminal-context-menu-item-icon-shell">
                      <Download aria-hidden="true" className="terminal-context-menu-icon" />
                    </span>
                    <span className="terminal-context-menu-label">Download</span>
                  </button>
                ) : null}
                {terminalContextMenu.quickExtractAction ? (
                  <button
                    className="terminal-context-menu-item"
                    onClick={handleExtractTerminalSelection}
                    role="menuitem"
                    title="Extract here"
                    type="button"
                  >
                    <span className="terminal-context-menu-item-icon-shell">
                      <FileArchive aria-hidden="true" className="terminal-context-menu-icon" />
                    </span>
                    <span className="terminal-context-menu-label">Extract Here</span>
                  </button>
                ) : null}
                <div aria-hidden="true" className="terminal-context-menu-divider" />
              </>
            ) : null}
            <button
              className="terminal-context-menu-item"
              disabled={terminalContextMenu.selectionText.trim() === ''}
              onClick={handleSearchTerminalSelectionWithGoogle}
              role="menuitem"
              type="button"
            >
              <span className="terminal-context-menu-item-icon-shell">
                <Search aria-hidden="true" className="terminal-context-menu-icon" />
              </span>
              <span className="terminal-context-menu-label">Search with Google</span>
            </button>
            <div aria-hidden="true" className="terminal-context-menu-divider" />
            <button
              className="terminal-context-menu-item"
              disabled={terminalContextMenu.selectionText.trim() === ''}
              onClick={handleCopyTerminalSelection}
              role="menuitem"
              type="button"
            >
              <span className="terminal-context-menu-item-icon-shell">
                <ClipboardCopy aria-hidden="true" className="terminal-context-menu-icon" />
              </span>
              <span className="terminal-context-menu-label">Copy</span>
            </button>
            <button
              className="terminal-context-menu-item"
              onClick={handlePasteIntoTerminal}
              role="menuitem"
              type="button"
            >
              <span className="terminal-context-menu-item-icon-shell">
                <ClipboardPaste aria-hidden="true" className="terminal-context-menu-icon" />
              </span>
              <span className="terminal-context-menu-label">Paste</span>
            </button>
            <button
              className="terminal-context-menu-item"
              onClick={handleSelectAllTerminalContent}
              role="menuitem"
              type="button"
            >
              <span className="terminal-context-menu-item-icon-shell">
                <TextSelect aria-hidden="true" className="terminal-context-menu-icon" />
              </span>
              <span className="terminal-context-menu-label">Select All</span>
            </button>
            <button
              className="terminal-context-menu-item"
              onClick={handleClearTerminalContent}
              role="menuitem"
              type="button"
            >
              <span className="terminal-context-menu-item-icon-shell">
                <BrushCleaning aria-hidden="true" className="terminal-context-menu-icon" />
              </span>
              <span className="terminal-context-menu-label">Clear</span>
            </button>
          </div>
        ) : null}
        {activeSshBrowserState ? (
          <div
            aria-controls={activeSshBrowserId}
            aria-label="Resize SFTP browser"
            aria-orientation="vertical"
            aria-valuemax={maxSshBrowserWidth}
            aria-valuemin={minSshBrowserWidth}
            aria-valuenow={activeSshBrowserWidth}
            className="ssh-browser-resizer"
            onKeyDown={handleSshBrowserResizeKeyDown}
            onPointerDown={handleSshBrowserResizePointerDown}
            role="separator"
            tabIndex={0}
          />
        ) : null}
        {hasMountedSshBrowsers ? (
          <div aria-hidden={!activeSshBrowserState} className="ssh-browser-dock">
            {mountedSshBrowserTabs.map((tab) => {
              const browserState = sshBrowserStates[tab.id]

              if (!browserState) {
                return null
              }

              const browserId = `ssh-browser-${tab.id}`
              const browserParentPath = browserState.path
                ? getRemoteDirectoryParentPath(browserState.path)
                : null
              const isActiveBrowser = browserState.tabId === activeSshBrowserState?.tabId

              return (
                <aside
                  aria-hidden={!isActiveBrowser}
                  className={`ssh-browser${isActiveBrowser ? ' is-active' : ''}`}
                  id={browserId}
                  key={tab.id}
                  role={isActiveBrowser ? 'dialog' : undefined}
                >
                  <div className="ssh-browser-header">
                    <div className="ssh-browser-heading">
                      <span className="ssh-browser-eyebrow">SFTP Browser</span>
                      <span
                        className="ssh-browser-path"
                        title={browserState.path ?? 'Loading path'}
                      >
                        {browserState.path ?? 'Loading path...'}
                      </span>
                    </div>
                    <button
                      aria-label="Close remote browser"
                      className="ssh-browser-close"
                      onClick={() => closeSshBrowserForTab(browserState.tabId)}
                      type="button"
                    >
                      <X aria-hidden="true" className="ssh-browser-close-icon" />
                    </button>
                  </div>
                  <div className="ssh-browser-toolbar">
                    <button
                      className="ssh-browser-toolbar-button"
                      disabled={!browserParentPath || browserState.isLoading}
                      onClick={() => handleOpenSshBrowserParent(browserState)}
                      type="button"
                    >
                      Up
                    </button>
                    <button
                      className="ssh-browser-toolbar-button"
                      disabled={browserState.isLoading}
                      onClick={() => handleRefreshSshBrowser(browserState)}
                      type="button"
                    >
                      {browserState.isLoading ? 'Loading...' : 'Refresh'}
                    </button>
                  </div>
                  {browserState.errorMessage ? (
                    <p className="ssh-browser-error">{browserState.errorMessage}</p>
                  ) : null}
                  <div className="ssh-browser-list">
                    {!browserState.errorMessage && browserState.entries.length === 0 ? (
                      <div className="ssh-browser-empty">
                        {browserState.isLoading
                          ? 'Loading remote files...'
                          : 'This folder is empty.'}
                      </div>
                    ) : null}
                    {browserState.entries.map((entry) => {
                      if (entry.isDirectory) {
                        return (
                          <button
                            className="ssh-browser-entry is-directory"
                            key={`dir-${entry.name}`}
                            onContextMenu={(event) =>
                              handleOpenSshBrowserContextMenu(event, browserState, entry)
                            }
                            onClick={() => handleOpenSshBrowserDirectory(browserState, entry)}
                            type="button"
                          >
                            <span className="ssh-browser-entry-main">
                              <Folder
                                aria-hidden="true"
                                className="ssh-browser-entry-icon ssh-browser-entry-icon-directory"
                              />
                              <span className="ssh-browser-entry-name">{entry.name}</span>
                            </span>
                          </button>
                        )
                      }

                      const fileIconDescriptor = getSshBrowserFileIconDescriptor(entry.name)
                      const FileIcon = fileIconDescriptor.icon

                      return (
                        <div
                          className="ssh-browser-entry"
                          key={`file-${entry.name}`}
                          onContextMenu={(event) =>
                            handleOpenSshBrowserContextMenu(event, browserState, entry)
                          }
                        >
                          <span className="ssh-browser-entry-main">
                            <FileIcon
                              aria-hidden="true"
                              className={`ssh-browser-entry-icon ${fileIconDescriptor.toneClassName}`}
                            />
                            <span className="ssh-browser-entry-name">{entry.name}</span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </aside>
              )
            })}
          </div>
        ) : null}
        {sshBrowserContextMenu ? (
          <div
            className="ssh-browser-context-menu"
            ref={sshBrowserContextMenuRef}
            role="menu"
            style={{
              left: sshBrowserContextMenu.x,
              top: sshBrowserContextMenu.y
            }}
          >
            {(() => {
              const browserState = sshBrowserStates[sshBrowserContextMenu.tabId]

              if (!browserState) {
                return null
              }

              return (
                <>
                  <button
                    className="ssh-browser-context-menu-item"
                    onClick={() =>
                      handleDownloadSshBrowserEntry(browserState, sshBrowserContextMenu.entry)
                    }
                    role="menuitem"
                    type="button"
                  >
                    <Download aria-hidden="true" className="ssh-browser-context-menu-icon" />
                    Download
                  </button>
                  <button
                    className="ssh-browser-context-menu-item"
                    onClick={() =>
                      handleRenameSshBrowserEntry(browserState, sshBrowserContextMenu.entry)
                    }
                    role="menuitem"
                    type="button"
                  >
                    <Pencil aria-hidden="true" className="ssh-browser-context-menu-icon" />
                    Rename
                  </button>
                  <button
                    className="ssh-browser-context-menu-item is-danger"
                    onClick={() =>
                      handleDeleteSshBrowserEntry(browserState, sshBrowserContextMenu.entry)
                    }
                    role="menuitem"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="ssh-browser-context-menu-icon" />
                    Delete
                  </button>
                </>
              )
            })()}
          </div>
        ) : null}
      </section>
      {isSshConfigDialogOpen ? (
        <SshConfigDialog
          key={sshServerBeingEdited?.id ?? 'new'}
          onClose={handleCloseSshConfigDialog}
          serverConfig={sshServerBeingEdited}
        />
      ) : null}
    </main>
  )
}

function App(): React.JSX.Element {
  useEffect(() => {
    const appElement = document.getElementById('root')

    if (appElement) {
      Modal.setAppElement(appElement)
    }
  }, [])

  return <TerminalApp />
}

export default App
