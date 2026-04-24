import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import {
  HighlightStyle,
  StreamLanguage,
  indentUnit,
  syntaxHighlighting
} from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { type Extension, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { diff as diffLanguage } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { nginx as nginxLanguage } from '@codemirror/legacy-modes/mode/nginx'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { properties as propertiesLanguage } from '@codemirror/legacy-modes/mode/properties'
import { sass } from '@codemirror/legacy-modes/mode/sass'
import { shell as shellLanguage } from '@codemirror/legacy-modes/mode/shell'
import { toml as tomlLanguage } from '@codemirror/legacy-modes/mode/toml'
import { tags as t } from '@lezer/highlight'
import CodeMirror from '@uiw/react-codemirror'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IBufferCell, type ITheme } from '@xterm/xterm'
import {
  ArrowUp,
  BrushCleaning,
  CirclePlus,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ClipboardPaste,
  Columns2,
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FilePlus,
  FileTerminal,
  FileText,
  FileVideoCamera,
  Folder,
  FolderOpen,
  FolderPlus,
  Palette,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rows2,
  Search,
  Server,
  Settings,
  Settings2,
  TextSelect,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Reorder, useDragControls } from 'motion/react'
import Modal from 'react-modal'
import '@xterm/xterm/css/xterm.css'
import type {
  AppSettings,
  AppStartupMode,
  QuickCommand,
  SftpBrowserOpenMode,
  TerminalCursorStyle
} from '../../shared/settings'
import type { RestorableTabState, SessionSnapshot, SessionTabSnapshot } from '../../shared/session'
import type { LocalTextFile } from '../../shared/shell'
import {
  defaultSshServerIcon,
  type SshAuthMethod,
  type SshDownloadProgressEvent,
  type SshRemoteDirectoryEntry,
  type SshRemoteTextFile,
  type SshServerIcon,
  type SshServerConfig,
  type SshServerConfigInput,
  type SshUploadProgressEvent
} from '../../shared/ssh'
import type { TerminalCreateOptions, TerminalCreateResult } from '../../shared/terminal'

type TabStatus = 'connecting' | 'ready' | 'closed'
type PaneSplitOrientation = 'columns' | 'rows'

interface TabPaneRecord {
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

interface TabRecord extends TabPaneRecord {
  activePaneId: string
  paneOrientation: PaneSplitOrientation | null
  panes: TabPaneRecord[]
}

interface TerminalRuntime {
  closed: boolean
  disposed: boolean
  disposeFocus: { dispose: () => void }
  disposeInput: { dispose: () => void }
  fitAddon: FitAddon
  reconnectTimeoutId: number | null
  terminal: Terminal
  terminalId: number | null
}

interface CreateTabOptions {
  createTerminal?: () => Promise<TerminalCreateResult>
  restoreState?: RestorableTabState
  terminalCreateOptions?: TerminalCreateOptions
  title?: string
}

interface PendingTerminalState {
  cwd: string
  title: string
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
  filterQuery: string
  isLoading: boolean
  pendingPath: string | null
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

interface TabContextMenuState {
  tabId: string
  x: number
  y: number
}

interface SshBrowserCreateDialogState {
  errorMessage: string | null
  isDirectory: boolean
  name: string
  tabId: string
}

type SshRemoteEditorLineEnding = '\n' | '\r' | '\r\n'

interface BaseSshRemoteEditorState {
  content: string
  errorMessage: string | null
  initialContent: string
  isSaving: boolean
  lineEnding: SshRemoteEditorLineEnding
  path: string
  size: number
  tabId: string
}

type SshRemoteEditorState =
  | (BaseSshRemoteEditorState & {
      kind: 'local'
    })
  | (BaseSshRemoteEditorState & {
      configId: string
      kind: 'ssh'
    })

interface SshRemoteEditorLoadingState {
  fileName: string
  path: string
}

interface SshRemoteEditorSyntaxLanguage {
  extensions: Extension[]
  label: string
}

type TextEditorFile = LocalTextFile | SshRemoteTextFile

interface TerminalContextMenuState {
  paneId: string
  quickChmodRunAction: TerminalQuickChmodRunAction | null
  quickDownloadAction: TerminalQuickDownloadAction | null
  quickExtractAction: TerminalQuickExtractAction | null
  selectionText: string
  tabId: string
  x: number
  y: number
}

interface TerminalQuickDownloadAction {
  configId: string
  remotePath: string
}

interface TerminalQuickExtractAction {
  command: string
}

interface TerminalQuickChmodRunAction {
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

type TerminalFontFamilyId = string
type TerminalColorSchemeId =
  | 'midnight-blue'
  | 'rose-pine'
  | 'dracula'
  | 'solarized-dark'
  | 'nord'
  | 'gruvbox-dark'
  | 'tokyo-night'
  | 'tomorrow-night'
  | 'catppuccin-mocha'
  | 'one-dark'
  | 'one-light'
  | 'monokai'
type TerminalFontWeight = '300' | '400' | '500' | '600' | '700'
type SettingsTransferAction = 'import' | 'export'
type SettingsTransferTone = 'success' | 'error'
type SettingsTabId = 'general' | 'appearance' | 'quickCommands'

interface TerminalColorScheme {
  description: string
  id: TerminalColorSchemeId
  label: string
  theme: ITheme
}

interface TerminalFontOption {
  fontFamily: string
  id: TerminalFontFamilyId
  label: string
}

interface TerminalFontWeightOption {
  description: string
  label: string
  value: TerminalFontWeight
}

interface RgbColor {
  blue: number
  green: number
  red: number
}

interface TerminalPalette {
  background: string
  black: string
  blue: string
  brightBlack: string
  brightBlue: string
  brightCyan: string
  brightGreen: string
  brightMagenta: string
  brightRed: string
  brightWhite: string
  brightYellow: string
  cyan: string
  foreground: string
  green: string
  magenta: string
  red: string
  white: string
  yellow: string
}

interface QuickCommandDraft {
  command: string
  title: string
}

type QuickOpenCommandGroupId = 'commands' | 'quickCommands' | 'servers'

interface QuickOpenCommandItem {
  action: () => void
  description: string
  disabled?: boolean
  group: QuickOpenCommandGroupId
  icon: LucideIcon
  id: string
  keywords: string[]
  sshServerIcon?: SshServerIcon | null
  shortcut: string[]
  title: string
}

interface QuickOpenCommandGroup {
  id: QuickOpenCommandGroupId
  label: string
}

const defaultTabTitle = '~'
const maxPersistedTerminalOutputLines = 500
const minTerminalFontSize = 10
const maxTerminalFontSize = 24
const maxTabPaneCount = 4
const searchRefreshDebounceMs = 120
const defaultSshBrowserWidth = 320
const maxSshBrowserWidth = 640
const minSshBrowserWidth = 240
const minTerminalStageWidth = 320
const sshBrowserOverlayBreakpointPx = 900
const sshReconnectDelayMs = 5000
const sshBrowserResizerWidth = 10
const sshRemoteCwdSequencePrefix = '\x1b]633;TerminalRemoteCwd='
const uploadProgressCircleRadius = 16
const uploadProgressCircleCircumference = 2 * Math.PI * uploadProgressCircleRadius
const quickOpenCommandGroups: QuickOpenCommandGroup[] = [
  {
    id: 'commands',
    label: 'Commands'
  },
  {
    id: 'quickCommands',
    label: 'Quick Commands'
  },
  {
    id: 'servers',
    label: 'Servers'
  }
]
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
const sshBrowserTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short'
})
const sshRemoteEditorShellExtensions = [StreamLanguage.define(shellLanguage)]
const sshRemoteEditorPropertiesExtensions = [StreamLanguage.define(propertiesLanguage)]
const sshRemoteEditorDiffExtensions = [StreamLanguage.define(diffLanguage)]
const sshRemoteEditorDockerExtensions = [StreamLanguage.define(dockerFile)]
const sshRemoteEditorNginxExtensions = [StreamLanguage.define(nginxLanguage)]
const sshRemoteEditorPowerShellExtensions = [StreamLanguage.define(powerShell)]
const sshRemoteEditorScssExtensions = [StreamLanguage.define(sass)]
const sshRemoteEditorTomlExtensions = [StreamLanguage.define(tomlLanguage)]
const sshRemoteEditorCssExtensions = [css()]
const sshRemoteEditorHtmlExtensions = [html()]
const sshRemoteEditorJavaExtensions = [java()]
const sshRemoteEditorJavaScriptExtensions = [javascript()]
const sshRemoteEditorJsonExtensions = [json()]
const sshRemoteEditorJsxExtensions = [javascript({ jsx: true })]
const sshRemoteEditorMarkdownExtensions = [markdown()]
const sshRemoteEditorPythonExtensions = [python()]
const sshRemoteEditorSqlExtensions = [sql()]
const sshRemoteEditorTypeScriptExtensions = [javascript({ typescript: true })]
const sshRemoteEditorTsxExtensions = [javascript({ jsx: true, typescript: true })]
const sshRemoteEditorXmlExtensions = [xml()]
const sshRemoteEditorYamlExtensions = [yaml()]
const sshRemoteEditorHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta],
      color: 'rgba(149, 166, 190, 0.76)'
    },
    {
      tag: [t.punctuation, t.separator, t.contentSeparator, t.angleBracket, t.bracket],
      color: '#b8c2d4'
    },
    {
      tag: [t.operator, t.operatorKeyword],
      color: '#b8c2d4'
    },
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.definitionKeyword,
        t.moduleKeyword,
        t.modifier,
        t.tagName
      ],
      color: '#83cbe8'
    },
    {
      tag: [t.attributeName, t.propertyName, t.labelName],
      color: '#83cbe8'
    },
    {
      tag: [t.string, t.special(t.string), t.inserted],
      color: '#a8d69a'
    },
    {
      tag: [t.number, t.bool, t.null, t.atom],
      color: '#d9b47d'
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
      color: '#a6b9ff'
    },
    {
      tag: [t.typeName, t.className, t.namespace],
      color: '#a6b9ff'
    },
    {
      tag: [t.regexp, t.escape, t.deleted, t.processingInstruction],
      color: '#eea481'
    },
    {
      tag: [t.variableName, t.self],
      color: '#c2cad8'
    },
    {
      tag: t.invalid,
      color: '#eea481',
      textDecoration: 'underline'
    }
  ])
)
const sshRemoteEditorCodeMirrorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: '#090e16',
      color: 'var(--color-text)',
      fontSize: '13px'
    },
    '&.cm-focused': {
      outline: 'none'
    },
    '.cm-scroller': {
      height: '100%',
      overflow: 'auto',
      padding: '18px 0',
      fontFamily: "'JetBrains Mono Variable', 'IBM Plex Mono', monospace",
      lineHeight: '1.6'
    },
    '.cm-content': {
      minHeight: '100%',
      caretColor: '#f3f6fc'
    },
    '.cm-line': {
      padding: '0 var(--remote-editor-editor-padding-x, 22px)'
    },
    '.cm-gutters': {
      minHeight: '100%',
      borderRight: '1px solid rgba(119, 215, 255, 0.12)',
      backgroundColor: 'rgba(6, 12, 19, 0.92)',
      color: 'rgba(149, 166, 190, 0.7)'
    },
    '.cm-gutter': {
      minHeight: '100%'
    },
    '.cm-gutterElement': {
      padding: '0 8px 0 10px',
      fontVariantNumeric: 'tabular-nums'
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.03)'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(255, 255, 255, 0.03)'
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#f3f6fc'
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(119, 215, 255, 0.22) !important'
    },
    '.cm-content ::selection': {
      backgroundColor: 'rgba(119, 215, 255, 0.22)'
    }
  },
  { dark: true }
)
const sshRemoteEditorBaseExtensions = [
  EditorState.tabSize.of(2),
  indentUnit.of('  '),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ spellcheck: 'false' }),
  sshRemoteEditorHighlighting,
  sshRemoteEditorCodeMirrorTheme
]
const sshRemoteEditorPlainLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: [],
  label: 'Plain text'
}
const sshRemoteEditorBashLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorShellExtensions,
  label: 'Shell'
}
const sshRemoteEditorBatchLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: [],
  label: 'Batch'
}
const sshRemoteEditorCssLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorCssExtensions,
  label: 'CSS'
}
const sshRemoteEditorCsvLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: [],
  label: 'CSV'
}
const sshRemoteEditorDiffLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorDiffExtensions,
  label: 'Diff'
}
const sshRemoteEditorDockerLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorDockerExtensions,
  label: 'Dockerfile'
}
const sshRemoteEditorEditorConfigLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorPropertiesExtensions,
  label: 'EditorConfig'
}
const sshRemoteEditorIgnoreLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: [],
  label: 'Ignore rules'
}
const sshRemoteEditorIniLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorPropertiesExtensions,
  label: 'INI'
}
const sshRemoteEditorJavaLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorJavaExtensions,
  label: 'Java'
}
const sshRemoteEditorJavaScriptLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorJavaScriptExtensions,
  label: 'JavaScript'
}
const sshRemoteEditorJsonLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorJsonExtensions,
  label: 'JSON'
}
const sshRemoteEditorJsxLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorJsxExtensions,
  label: 'JSX'
}
const sshRemoteEditorMakefileLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: [],
  label: 'Makefile'
}
const sshRemoteEditorMarkdownLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorMarkdownExtensions,
  label: 'Markdown'
}
const sshRemoteEditorHtmlLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorHtmlExtensions,
  label: 'HTML'
}
const sshRemoteEditorXmlLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorXmlExtensions,
  label: 'XML'
}
const sshRemoteEditorNginxLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorNginxExtensions,
  label: 'Nginx'
}
const sshRemoteEditorPowerShellLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorPowerShellExtensions,
  label: 'PowerShell'
}
const sshRemoteEditorPropertiesLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorPropertiesExtensions,
  label: 'Properties'
}
const sshRemoteEditorPythonLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorPythonExtensions,
  label: 'Python'
}
const sshRemoteEditorScssLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorScssExtensions,
  label: 'SCSS'
}
const sshRemoteEditorSqlLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorSqlExtensions,
  label: 'SQL'
}
const sshRemoteEditorTomlLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorTomlExtensions,
  label: 'TOML'
}
const sshRemoteEditorTsxLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorTsxExtensions,
  label: 'TSX'
}
const sshRemoteEditorTypeScriptLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorTypeScriptExtensions,
  label: 'TypeScript'
}
const sshRemoteEditorYamlLanguage: SshRemoteEditorSyntaxLanguage = {
  extensions: sshRemoteEditorYamlExtensions,
  label: 'YAML'
}
const sshRemoteEditorLanguageByExactName = new Map<string, SshRemoteEditorSyntaxLanguage>([
  ['.bash_profile', sshRemoteEditorBashLanguage],
  ['.bashrc', sshRemoteEditorBashLanguage],
  ['.editorconfig', sshRemoteEditorEditorConfigLanguage],
  ['.gitconfig', sshRemoteEditorIniLanguage],
  ['.npmrc', sshRemoteEditorIniLanguage],
  ['.profile', sshRemoteEditorBashLanguage],
  ['.yarnrc', sshRemoteEditorIniLanguage],
  ['.zlogin', sshRemoteEditorBashLanguage],
  ['.zlogout', sshRemoteEditorBashLanguage],
  ['.zprofile', sshRemoteEditorBashLanguage],
  ['.zshenv', sshRemoteEditorBashLanguage],
  ['.zshrc', sshRemoteEditorBashLanguage],
  ['dockerfile', sshRemoteEditorDockerLanguage],
  ['makefile', sshRemoteEditorMakefileLanguage],
  ['nginx.conf', sshRemoteEditorNginxLanguage],
  ['readme', sshRemoteEditorMarkdownLanguage]
])
const sshRemoteEditorLanguageBySuffix = new Map<string, SshRemoteEditorSyntaxLanguage>([
  ['.bash', sshRemoteEditorBashLanguage],
  ['.bat', sshRemoteEditorBatchLanguage],
  ['.cmd', sshRemoteEditorBatchLanguage],
  ['.command', sshRemoteEditorBashLanguage],
  ['.conf', sshRemoteEditorIniLanguage],
  ['.cfg', sshRemoteEditorIniLanguage],
  ['.css', sshRemoteEditorCssLanguage],
  ['.csv', sshRemoteEditorCsvLanguage],
  ['.cjs', sshRemoteEditorJavaScriptLanguage],
  ['.cts', sshRemoteEditorTypeScriptLanguage],
  ['.diff', sshRemoteEditorDiffLanguage],
  ['.envrc', sshRemoteEditorBashLanguage],
  ['.gitignore', sshRemoteEditorIgnoreLanguage],
  ['.html', sshRemoteEditorHtmlLanguage],
  ['.htm', sshRemoteEditorHtmlLanguage],
  ['.ini', sshRemoteEditorIniLanguage],
  ['.java', sshRemoteEditorJavaLanguage],
  ['.js', sshRemoteEditorJavaScriptLanguage],
  ['.json', sshRemoteEditorJsonLanguage],
  ['.jsonc', sshRemoteEditorJsonLanguage],
  ['.jsx', sshRemoteEditorJsxLanguage],
  ['.log', sshRemoteEditorPlainLanguage],
  ['.md', sshRemoteEditorMarkdownLanguage],
  ['.mdx', sshRemoteEditorMarkdownLanguage],
  ['.mjs', sshRemoteEditorJavaScriptLanguage],
  ['.mts', sshRemoteEditorTypeScriptLanguage],
  ['.ps1', sshRemoteEditorPowerShellLanguage],
  ['.psd1', sshRemoteEditorPowerShellLanguage],
  ['.psm1', sshRemoteEditorPowerShellLanguage],
  ['.properties', sshRemoteEditorPropertiesLanguage],
  ['.py', sshRemoteEditorPythonLanguage],
  ['.scss', sshRemoteEditorScssLanguage],
  ['.sh', sshRemoteEditorBashLanguage],
  ['.sql', sshRemoteEditorSqlLanguage],
  ['.svg', sshRemoteEditorXmlLanguage],
  ['.toml', sshRemoteEditorTomlLanguage],
  ['.ts', sshRemoteEditorTypeScriptLanguage],
  ['.tsx', sshRemoteEditorTsxLanguage],
  ['.xml', sshRemoteEditorXmlLanguage],
  ['.yaml', sshRemoteEditorYamlLanguage],
  ['.yml', sshRemoteEditorYamlLanguage],
  ['.zsh', sshRemoteEditorBashLanguage]
])

function applyThemeAlpha(color: string, alpha: number): string {
  const rgbColor = parseColorToRgb(color)

  if (!rgbColor) {
    return color
  }

  return `rgba(${rgbColor.red}, ${rgbColor.green}, ${rgbColor.blue}, ${alpha})`
}

function createTerminalThemeFromPalette(palette: TerminalPalette): ITheme {
  return {
    ...palette,
    cursor: palette.foreground,
    cursorAccent: palette.background,
    selectionBackground: applyThemeAlpha(palette.blue, 0.28),
    selectionInactiveBackground: applyThemeAlpha(palette.blue, 0.18)
  }
}

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
const rosePineTerminalTheme = {
  background: '#191724',
  black: '#26233a',
  blue: '#9ccfd8',
  brightBlack: '#6e6a86',
  brightBlue: '#c4a7e7',
  brightCyan: '#9ccfd8',
  brightGreen: '#31748f',
  brightMagenta: '#ebbcba',
  brightRed: '#eb6f92',
  brightWhite: '#e0def4',
  brightYellow: '#f6c177',
  cursor: '#e0def4',
  cursorAccent: '#191724',
  cyan: '#9ccfd8',
  foreground: '#e0def4',
  green: '#31748f',
  magenta: '#c4a7e7',
  red: '#eb6f92',
  selectionBackground: 'rgba(196, 167, 231, 0.2)',
  selectionInactiveBackground: 'rgba(196, 167, 231, 0.14)',
  white: '#e0def4',
  yellow: '#f6c177'
} satisfies ITheme
const tomorrowNightTerminalTheme = {
  background: '#1d1f21',
  black: '#000000',
  blue: '#81a2be',
  brightBlack: '#000000',
  brightBlue: '#81a2be',
  brightCyan: '#8abeb7',
  brightGreen: '#b5bd68',
  brightMagenta: '#b294bb',
  brightRed: '#cc6666',
  brightWhite: '#ffffff',
  brightYellow: '#f0c674',
  cursor: '#c5c8c6',
  cursorAccent: '#1d1f21',
  cyan: '#8abeb7',
  foreground: '#c5c8c6',
  green: '#b5bd68',
  magenta: '#b294bb',
  red: '#cc6666',
  selectionBackground: '#373b41',
  selectionForeground: '#c5c8c6',
  selectionInactiveBackground: '#373b41',
  white: '#ffffff',
  yellow: '#f0c674'
} satisfies ITheme
const terminalColorSchemes: TerminalColorScheme[] = [
  {
    description: 'Cool blues on a hard black base. Matches the current default.',
    id: 'midnight-blue',
    label: 'Midnight Blue',
    theme: defaultTerminalTheme
  },
  {
    description: 'Muted mauves with soft cyan for calmer long sessions.',
    id: 'rose-pine',
    label: 'Rose Pine',
    theme: rosePineTerminalTheme
  },
  {
    description: 'High-contrast violet palette with vivid neon accents.',
    id: 'dracula',
    label: 'Dracula',
    theme: createTerminalThemeFromPalette({
      background: '#282a36',
      foreground: '#f8f8f2',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    })
  },
  {
    description: 'Low-glare classic with balanced contrast for long reads.',
    id: 'solarized-dark',
    label: 'Solarized Dark',
    theme: createTerminalThemeFromPalette({
      background: '#002b36',
      foreground: '#839496',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    })
  },
  {
    description: 'Cool arctic tones with soft contrast and restrained saturation.',
    id: 'nord',
    label: 'Nord',
    theme: createTerminalThemeFromPalette({
      background: '#2e3440',
      foreground: '#d8dee9',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    })
  },
  {
    description: 'Warm earthy colors on a muted dark background.',
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    theme: createTerminalThemeFromPalette({
      background: '#282828',
      foreground: '#ebdbb2',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    })
  },
  {
    description: 'Deep navy base with sharp blues and pinks.',
    id: 'tokyo-night',
    label: 'Tokyo Night',
    theme: createTerminalThemeFromPalette({
      background: '#1a1b26',
      foreground: '#c0caf5',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    })
  },
  {
    description: 'Muted retro dark palette with soft ANSI contrast from the Tomorrow set.',
    id: 'tomorrow-night',
    label: 'Tomorrow Night',
    theme: tomorrowNightTerminalTheme
  },
  {
    description: 'Soft mocha neutrals with pastel accents.',
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    theme: createTerminalThemeFromPalette({
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    })
  },
  {
    description: 'Balanced Atom-era dark theme with clear syntax colors.',
    id: 'one-dark',
    label: 'One Dark',
    theme: {
      background: '#1e2127',
      black: '#1e2127',
      blue: '#61afef',
      brightBlack: '#5c6370',
      brightBlue: '#61afef',
      brightCyan: '#56b6c2',
      brightGreen: '#98c379',
      brightMagenta: '#c678dd',
      brightRed: '#e06c75',
      brightWhite: '#ffffff',
      brightYellow: '#d19a66',
      cursor: '#5c6370',
      cursorAccent: '#1e2127',
      cyan: '#56b6c2',
      foreground: '#abb2bf',
      green: '#98c379',
      magenta: '#c678dd',
      red: '#e06c75',
      selectionBackground: '#3a3f4b',
      selectionInactiveBackground: '#3a3f4b',
      white: '#abb2bf',
      yellow: '#d19a66'
    } satisfies ITheme
  },
  {
    description: 'Clean light variant of One Dark with muted contrast.',
    id: 'one-light',
    label: 'One Light',
    theme: {
      background: '#f9f9f9',
      black: '#000000',
      blue: '#4078f2',
      brightBlack: '#383a42',
      brightBlue: '#4078f2',
      brightCyan: '#0184bc',
      brightGreen: '#50a14f',
      brightMagenta: '#a626a4',
      brightRed: '#e45649',
      brightWhite: '#ffffff',
      brightYellow: '#986801',
      cursor: '#383a42',
      cursorAccent: '#f9f9f9',
      cyan: '#0184bc',
      foreground: '#383a42',
      green: '#50a14f',
      magenta: '#a626a4',
      red: '#e45649',
      selectionBackground: '#3a3f4b',
      selectionForeground: '#ffffff',
      selectionInactiveBackground: '#3a3f4b',
      white: '#a0a1a7',
      yellow: '#986801'
    } satisfies ITheme
  },
  {
    description: 'Classic high-energy dark theme with vivid accent colors.',
    id: 'monokai',
    label: 'Monokai',
    theme: createTerminalThemeFromPalette({
      background: '#272822',
      foreground: '#f8f8f2',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#f4bf75',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5'
    })
  }
]
const defaultTerminalColorScheme = terminalColorSchemes[0]
const terminalColorSchemesById = new Map<TerminalColorSchemeId, TerminalColorScheme>(
  terminalColorSchemes.map((colorScheme) => [colorScheme.id, colorScheme])
)
const terminalFontFamilies = [
  'Fira Code Variable',
  'JetBrains Mono Variable',
  'Cascadia Code Variable',
  'Hack',
  'Source Code Pro Variable',
  'Inconsolata Variable',
  'IBM Plex Mono',
  'Ubuntu Mono',
  'DejaVu Mono'
] as const
const defaultTerminalFontFamilyId = 'JetBrains Mono Variable'
const defaultTerminalFontSize = 14
const defaultAppStartupMode: AppStartupMode = 'restorePreviousSession'
const defaultSftpBrowserOpenMode: SftpBrowserOpenMode = 'restoreLastSession'
const defaultTerminalCursorBlink = true
const defaultTerminalCursorStyle: TerminalCursorStyle = 'bar'
const defaultTerminalCursorWidth = 2
const defaultTerminalLineHeight = 1.35
const minTerminalCursorWidth = 1
const maxTerminalCursorWidth = 6
const minTerminalLineHeight = 1
const maxTerminalLineHeight = 2
const terminalCursorStyleOptions: Array<{ label: string; value: TerminalCursorStyle }> = [
  { label: 'Bar', value: 'bar' },
  { label: 'Block', value: 'block' },
  { label: 'Underline', value: 'underline' }
]
const appStartupModeOptions: Array<{ label: string; value: AppStartupMode }> = [
  { label: 'Restore previous session', value: 'restorePreviousSession' },
  { label: 'Start clean', value: 'startClean' }
]
const sftpBrowserOpenModeOptions: Array<{ label: string; value: SftpBrowserOpenMode }> = [
  { label: 'Restore last session', value: 'restoreLastSession' },
  { label: 'Open current folder', value: 'openCurrentFolder' }
]
const terminalFontWeightOptions: TerminalFontWeightOption[] = [
  { description: 'Light', label: '300', value: '300' },
  { description: 'Regular', label: '400', value: '400' },
  { description: 'Medium', label: '500', value: '500' },
  { description: 'Semibold', label: '600', value: '600' },
  { description: 'Bold', label: '700', value: '700' }
]
const defaultTerminalFontWeight = terminalFontWeightOptions[1]?.value ?? '400'
const terminalFontWeightOptionsByValue = new Map<TerminalFontWeight, TerminalFontWeightOption>(
  terminalFontWeightOptions.map((fontWeightOption) => [fontWeightOption.value, fontWeightOption])
)
const terminalFontFamilyIds = new Set<TerminalFontFamilyId>(terminalFontFamilies)
const terminalFontLabelOverrides: Record<string, string> = {
  'DejaVu Mono': 'DejaVu Sans Mono'
}

function getSearchTerminalTheme(theme: ITheme): ITheme {
  return {
    ...theme,
    selectionBackground: '#e0cb7d',
    selectionForeground: '#171102',
    selectionInactiveBackground: '#ffd84a'
  }
}

function normalizeTerminalColorSchemeId(
  colorSchemeId: string | null | undefined
): TerminalColorSchemeId {
  if (colorSchemeId && terminalColorSchemesById.has(colorSchemeId as TerminalColorSchemeId)) {
    return colorSchemeId as TerminalColorSchemeId
  }

  return defaultTerminalColorScheme.id
}

function clampTerminalFontSize(fontSize: number): number {
  return Math.min(Math.max(Math.round(fontSize), minTerminalFontSize), maxTerminalFontSize)
}

function normalizeTerminalFontFamilyId(
  fontFamilyId: string | null | undefined
): TerminalFontFamilyId {
  if (fontFamilyId && terminalFontFamilyIds.has(fontFamilyId.trim() as TerminalFontFamilyId)) {
    return fontFamilyId.trim()
  }

  return defaultTerminalFontFamilyId
}

function normalizeTerminalFontSize(fontSize: number): number {
  if (Number.isFinite(fontSize)) {
    return clampTerminalFontSize(fontSize)
  }

  return defaultTerminalFontSize
}

function normalizeTerminalFontWeight(fontWeight: string | null | undefined): TerminalFontWeight {
  if (fontWeight && terminalFontWeightOptionsByValue.has(fontWeight as TerminalFontWeight)) {
    return fontWeight as TerminalFontWeight
  }

  return defaultTerminalFontWeight
}

function normalizeTerminalCursorStyle(cursorStyle: string | null | undefined): TerminalCursorStyle {
  if (cursorStyle === 'bar' || cursorStyle === 'block' || cursorStyle === 'underline') {
    return cursorStyle
  }

  return defaultTerminalCursorStyle
}

function clampTerminalCursorWidth(cursorWidth: number): number {
  return Math.min(Math.max(Math.round(cursorWidth), minTerminalCursorWidth), maxTerminalCursorWidth)
}

function normalizeTerminalCursorWidth(cursorWidth: number): number {
  if (Number.isFinite(cursorWidth)) {
    return clampTerminalCursorWidth(cursorWidth)
  }

  return defaultTerminalCursorWidth
}

function normalizeTerminalThemeOverrideColor(color: string | null | undefined): string | null {
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

function normalizeTerminalCursorColor(cursorColor: string | null | undefined): string | null {
  return normalizeTerminalThemeOverrideColor(cursorColor)
}

function normalizeTerminalSelectionColor(selectionColor: string | null | undefined): string | null {
  return normalizeTerminalThemeOverrideColor(selectionColor)
}

function clampTerminalLineHeight(lineHeight: number): number {
  const clampedLineHeight = Math.min(
    Math.max(lineHeight, minTerminalLineHeight),
    maxTerminalLineHeight
  )
  return Math.round(clampedLineHeight * 100) / 100
}

function normalizeTerminalLineHeight(lineHeight: number): number {
  if (Number.isFinite(lineHeight)) {
    return clampTerminalLineHeight(lineHeight)
  }

  return defaultTerminalLineHeight
}

function parseColorToRgb(color: string | null | undefined): RgbColor | null {
  if (typeof color !== 'string') {
    return null
  }

  const normalizedColor = color.trim()
  const hexMatch = normalizedColor.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)

  if (hexMatch) {
    const hexColor = hexMatch[1]

    if (hexColor.length === 3) {
      return {
        blue: Number.parseInt(`${hexColor[2]}${hexColor[2]}`, 16),
        green: Number.parseInt(`${hexColor[1]}${hexColor[1]}`, 16),
        red: Number.parseInt(`${hexColor[0]}${hexColor[0]}`, 16)
      }
    }

    return {
      blue: Number.parseInt(hexColor.slice(4, 6), 16),
      green: Number.parseInt(hexColor.slice(2, 4), 16),
      red: Number.parseInt(hexColor.slice(0, 2), 16)
    }
  }

  const rgbMatch = normalizedColor.match(/^rgba?\(([^)]+)\)$/i)

  if (!rgbMatch) {
    return null
  }

  const channels = rgbMatch[1]
    .split(',')
    .slice(0, 3)
    .map((channel) => Number.parseFloat(channel.trim()))

  if (
    channels.length !== 3 ||
    channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)
  ) {
    return null
  }

  return {
    blue: Math.round(channels[2]),
    green: Math.round(channels[1]),
    red: Math.round(channels[0])
  }
}

function getHexColorInputValue(color: string | null | undefined, fallbackColor: string): string {
  const rgbColor = parseColorToRgb(color)

  if (!rgbColor) {
    return fallbackColor
  }

  return `#${[rgbColor.red, rgbColor.green, rgbColor.blue]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`
}

function applyAlphaToColor(color: string | null | undefined, alpha: number): string {
  const rgbColor = parseColorToRgb(color)

  if (!rgbColor) {
    return color ?? defaultTerminalTheme.background ?? '#000000'
  }

  return `rgba(${rgbColor.red}, ${rgbColor.green}, ${rgbColor.blue}, ${alpha})`
}

function getReadableOverlayForeground(
  color: string,
  fallbackForeground: string | null | undefined
): string {
  const rgbColor = parseColorToRgb(color)

  if (!rgbColor) {
    return fallbackForeground ?? '#000000'
  }

  const relativeLuminance =
    (0.2126 * rgbColor.red + 0.7152 * rgbColor.green + 0.0722 * rgbColor.blue) / 255

  return relativeLuminance >= 0.55 ? '#000000' : '#ffffff'
}

function getConfiguredTerminalTheme(
  baseTheme: ITheme,
  cursorColor: string | null,
  selectionColor: string | null
): ITheme {
  const normalizedCursorColor = normalizeTerminalCursorColor(cursorColor)
  const normalizedSelectionColor = normalizeTerminalSelectionColor(selectionColor)

  return {
    ...baseTheme,
    cursor: normalizedCursorColor ?? baseTheme.cursor ?? baseTheme.foreground,
    cursorAccent: normalizedCursorColor
      ? getReadableOverlayForeground(normalizedCursorColor, baseTheme.cursorAccent)
      : baseTheme.cursorAccent,
    selectionBackground: normalizedSelectionColor
      ? applyAlphaToColor(normalizedSelectionColor, 0.34)
      : baseTheme.selectionBackground,
    selectionForeground: normalizedSelectionColor
      ? getReadableOverlayForeground(normalizedSelectionColor, baseTheme.foreground)
      : baseTheme.selectionForeground,
    selectionInactiveBackground: normalizedSelectionColor
      ? applyAlphaToColor(normalizedSelectionColor, 0.22)
      : baseTheme.selectionInactiveBackground
  }
}

function normalizeAppStartupMode(startupMode: string | null | undefined): AppStartupMode {
  if (startupMode === 'restorePreviousSession' || startupMode === 'startClean') {
    return startupMode
  }

  return defaultAppStartupMode
}

function normalizeSftpBrowserOpenMode(
  sftpBrowserOpenMode: string | null | undefined
): SftpBrowserOpenMode {
  if (sftpBrowserOpenMode === 'restoreLastSession' || sftpBrowserOpenMode === 'openCurrentFolder') {
    return sftpBrowserOpenMode
  }

  return defaultSftpBrowserOpenMode
}

function normalizeDefaultNewTabDirectory(
  defaultNewTabDirectory: string | null | undefined
): string {
  return typeof defaultNewTabDirectory === 'string' ? defaultNewTabDirectory.trim() : ''
}

function normalizeQuickCommandTitle(title: string | null | undefined): string {
  return typeof title === 'string' ? title.trim() : ''
}

function normalizeQuickCommandCommand(command: string | null | undefined): string {
  return typeof command === 'string' ? command.trim() : ''
}

function normalizeQuickCommands(quickCommands: QuickCommand[] | null | undefined): QuickCommand[] {
  if (!Array.isArray(quickCommands)) {
    return []
  }

  const seenIds = new Set<string>()

  return quickCommands
    .map((quickCommand) => {
      const id = typeof quickCommand.id === 'string' ? quickCommand.id.trim() : ''
      const title = normalizeQuickCommandTitle(quickCommand.title)
      const command = normalizeQuickCommandCommand(quickCommand.command)

      if (id === '' || title === '' || command === '' || seenIds.has(id)) {
        return null
      }

      seenIds.add(id)

      return {
        command,
        id,
        title
      }
    })
    .filter((quickCommand): quickCommand is QuickCommand => quickCommand !== null)
}

function getQuickCommandTerminalInput(command: string): string {
  const placeholder = '{}'
  const placeholderIndex = command.indexOf(placeholder)

  if (placeholderIndex === -1) {
    return `${command}\r`
  }

  const prefix = command.slice(0, placeholderIndex)
  const suffix = command.slice(placeholderIndex + placeholder.length)
  const moveCursorLeft = '\u001b[D'.repeat(Array.from(suffix).length)

  return `${prefix}${suffix}${moveCursorLeft}`
}

function createQuickCommandDraft(): QuickCommandDraft {
  return {
    command: '',
    title: ''
  }
}

function createQuickCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `quick-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeQuickOpenQuery(query: string): string {
  return query.trim().toLowerCase()
}

function getQuickOpenTokens(candidate: string): string[] {
  return candidate.split(/[^a-z0-9]+/).filter((token) => token !== '')
}

function getQuickOpenSubstringScore(candidate: string, query: string, baseScore: number): number {
  const matchIndex = candidate.indexOf(query)

  if (matchIndex === -1) {
    return -1
  }

  const isWordBoundaryMatch = matchIndex === 0 || /[^a-z0-9]/.test(candidate[matchIndex - 1] ?? '')

  return (
    baseScore +
    (isWordBoundaryMatch ? 18 : 0) -
    Math.min(matchIndex, 12) -
    Math.min(candidate.length - query.length, 10)
  )
}

function getQuickOpenTokenPrefixScore(candidate: string, query: string, baseScore: number): number {
  const tokens = getQuickOpenTokens(candidate)
  let bestScore = -1

  for (const [tokenIndex, token] of tokens.entries()) {
    if (!token.startsWith(query)) {
      continue
    }

    bestScore = Math.max(
      bestScore,
      baseScore - tokenIndex * 2 - Math.min(token.length - query.length, 8)
    )
  }

  return bestScore
}

function getQuickOpenAcronymScore(candidate: string, query: string, baseScore: number): number {
  const tokens = getQuickOpenTokens(candidate)

  if (tokens.length < 2) {
    return -1
  }

  const acronym = tokens.map((token) => token[0]).join('')

  if (!acronym.startsWith(query)) {
    return -1
  }

  return baseScore - Math.min(acronym.length - query.length, 4)
}

function getQuickOpenTokenFuzzyScore(candidate: string, query: string, baseScore: number): number {
  const tokens = getQuickOpenTokens(candidate)
  let bestScore = -1

  for (const token of tokens) {
    let consecutiveCharacters = 0
    let gapPenalty = 0
    let lastMatchIndex = -1
    let searchStartIndex = 0
    let score = baseScore - Math.min(token.length - query.length, 8)
    let hasMatched = true

    for (const character of query) {
      const matchIndex = token.indexOf(character, searchStartIndex)

      if (matchIndex === -1) {
        hasMatched = false
        break
      }

      if (lastMatchIndex === -1) {
        gapPenalty += matchIndex
        consecutiveCharacters = 1
      } else {
        const gapSize = matchIndex - lastMatchIndex - 1
        gapPenalty += gapSize
        consecutiveCharacters = gapSize === 0 ? consecutiveCharacters + 1 : 1
      }

      score += 4 + Math.min(consecutiveCharacters, 4)
      lastMatchIndex = matchIndex
      searchStartIndex = matchIndex + 1
    }

    if (!hasMatched) {
      continue
    }

    bestScore = Math.max(bestScore, score - gapPenalty * 3)
  }

  return bestScore
}

function getQuickOpenCommandScore(command: QuickOpenCommandItem, query: string): number {
  if (query === '') {
    return 0
  }

  const normalizedTitle = normalizeQuickOpenQuery(command.title)
  const normalizedDescription = normalizeQuickOpenQuery(command.description)
  const normalizedKeywords = command.keywords.map((keyword) => normalizeQuickOpenQuery(keyword))
  const compactTitle = getQuickOpenTokens(normalizedTitle).join('')
  const compactKeywords = normalizedKeywords.map((keyword) => getQuickOpenTokens(keyword).join(''))

  return Math.max(
    getQuickOpenSubstringScore(normalizedTitle, query, 420),
    getQuickOpenTokenPrefixScore(normalizedTitle, query, 380),
    getQuickOpenTokenFuzzyScore(normalizedTitle, query, 320),
    getQuickOpenSubstringScore(compactTitle, query, 300),
    getQuickOpenAcronymScore(normalizedTitle, query, 260),
    getQuickOpenSubstringScore(normalizedDescription, query, 180),
    ...normalizedKeywords.flatMap((keyword, index) => [
      getQuickOpenSubstringScore(keyword, query, 340 - index * 4),
      getQuickOpenTokenPrefixScore(keyword, query, 300 - index * 4),
      getQuickOpenTokenFuzzyScore(keyword, query, 250 - index * 4),
      getQuickOpenSubstringScore(compactKeywords[index] ?? '', query, 220 - index * 4),
      getQuickOpenAcronymScore(keyword, query, 200 - index * 4)
    ])
  )
}

function createAppSettings({
  defaultNewTabDirectory,
  quickCommands,
  sftpBrowserOpenMode,
  startupMode,
  terminalColorSchemeId,
  terminalCursorBlink,
  terminalCursorColor,
  terminalSelectionColor,
  terminalCursorStyle,
  terminalCursorWidth,
  terminalFontFamilyId,
  terminalFontSize,
  terminalFontWeight,
  terminalLineHeight
}: {
  defaultNewTabDirectory: string
  quickCommands: QuickCommand[]
  sftpBrowserOpenMode: SftpBrowserOpenMode
  startupMode: AppStartupMode
  terminalColorSchemeId: TerminalColorSchemeId
  terminalCursorBlink: boolean
  terminalCursorColor: string | null
  terminalSelectionColor: string | null
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorWidth: number
  terminalFontFamilyId: TerminalFontFamilyId
  terminalFontSize: number
  terminalFontWeight: TerminalFontWeight
  terminalLineHeight: number
}): AppSettings {
  return {
    general: {
      defaultNewTabDirectory: normalizeDefaultNewTabDirectory(defaultNewTabDirectory),
      sftpBrowserOpenMode: normalizeSftpBrowserOpenMode(sftpBrowserOpenMode),
      startupMode: normalizeAppStartupMode(startupMode)
    },
    quickCommands: normalizeQuickCommands(quickCommands),
    terminal: {
      colorSchemeId: terminalColorSchemeId,
      cursorBlink: terminalCursorBlink,
      cursorColor: normalizeTerminalCursorColor(terminalCursorColor),
      selectionColor: normalizeTerminalSelectionColor(terminalSelectionColor),
      cursorStyle: normalizeTerminalCursorStyle(terminalCursorStyle),
      cursorWidth: normalizeTerminalCursorWidth(terminalCursorWidth),
      fontFamilyId: terminalFontFamilyId,
      fontSize: terminalFontSize,
      fontWeight: terminalFontWeight,
      lineHeight: normalizeTerminalLineHeight(terminalLineHeight)
    },
    version: 1
  }
}

function getNormalizedAppSettings(settings: AppSettings): {
  defaultNewTabDirectory: string
  quickCommands: QuickCommand[]
  sftpBrowserOpenMode: SftpBrowserOpenMode
  startupMode: AppStartupMode
  terminalColorSchemeId: TerminalColorSchemeId
  terminalCursorBlink: boolean
  terminalCursorColor: string | null
  terminalSelectionColor: string | null
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorWidth: number
  terminalFontFamilyId: TerminalFontFamilyId
  terminalFontSize: number
  terminalFontWeight: TerminalFontWeight
  terminalLineHeight: number
} {
  return {
    defaultNewTabDirectory: normalizeDefaultNewTabDirectory(
      settings.general.defaultNewTabDirectory
    ),
    quickCommands: normalizeQuickCommands(settings.quickCommands),
    sftpBrowserOpenMode: normalizeSftpBrowserOpenMode(settings.general.sftpBrowserOpenMode),
    startupMode: normalizeAppStartupMode(settings.general.startupMode),
    terminalColorSchemeId: normalizeTerminalColorSchemeId(settings.terminal.colorSchemeId),
    terminalCursorBlink:
      typeof settings.terminal.cursorBlink === 'boolean'
        ? settings.terminal.cursorBlink
        : defaultTerminalCursorBlink,
    terminalCursorColor: normalizeTerminalCursorColor(settings.terminal.cursorColor),
    terminalSelectionColor: normalizeTerminalSelectionColor(settings.terminal.selectionColor),
    terminalCursorStyle: normalizeTerminalCursorStyle(settings.terminal.cursorStyle),
    terminalCursorWidth: normalizeTerminalCursorWidth(settings.terminal.cursorWidth),
    terminalFontFamilyId: normalizeTerminalFontFamilyId(settings.terminal.fontFamilyId),
    terminalFontSize: normalizeTerminalFontSize(settings.terminal.fontSize),
    terminalFontWeight: normalizeTerminalFontWeight(settings.terminal.fontWeight),
    terminalLineHeight: normalizeTerminalLineHeight(settings.terminal.lineHeight)
  }
}

function getTerminalFontFamilyCss(fontFamilyId: TerminalFontFamilyId): string {
  const escapedFontFamily = fontFamilyId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escapedFontFamily}", ui-monospace, monospace`
}

function createTerminalFontOption(fontFamilyId: TerminalFontFamilyId): TerminalFontOption {
  return {
    fontFamily: getTerminalFontFamilyCss(fontFamilyId),
    id: fontFamilyId,
    label: terminalFontLabelOverrides[fontFamilyId] ?? fontFamilyId.replace(/\s+Variable$/i, '')
  }
}

const defaultTerminalFontOption = createTerminalFontOption(defaultTerminalFontFamilyId)
const bundledTerminalFontOptions = terminalFontFamilies.map((fontFamily) =>
  createTerminalFontOption(fontFamily)
)
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
  cursorBlink: defaultTerminalCursorBlink,
  cursorStyle: defaultTerminalCursorStyle,
  cursorWidth: defaultTerminalCursorWidth,
  fontFamily: defaultTerminalFontOption.fontFamily,
  fontSize: defaultTerminalFontSize,
  fontWeight: defaultTerminalFontWeight,
  lineHeight: defaultTerminalLineHeight,
  macOptionIsMeta: true,
  scrollback: 5000,
  theme: defaultTerminalTheme
} satisfies ConstructorParameters<typeof Terminal>[0]

const defaultSshConfigInput: SshServerConfigInput = {
  authMethod: 'privateKey',
  defaultRemoteStartPath: '',
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

function createPaneRecord(
  paneId: string,
  options: {
    outputLines?: string[]
    restoreState: RestorableTabState
    title: string
  }
): TabPaneRecord {
  return {
    id: paneId,
    outputLines: clonePersistedOutputLines(options.outputLines),
    restoreState: cloneRestorableTabState(options.restoreState),
    status: 'connecting',
    terminalId: null,
    title: options.title
  }
}

function getPaneById(
  tab: Pick<TabRecord, 'activePaneId' | 'panes'>,
  paneId: string
): TabPaneRecord | null {
  return tab.panes.find((pane) => pane.id === paneId) ?? null
}

function getActivePane(tab: Pick<TabRecord, 'activePaneId' | 'panes'>): TabPaneRecord | null {
  return getPaneById(tab, tab.activePaneId) ?? tab.panes[0] ?? null
}

function canSplitTabPane(
  tab: Pick<TabRecord, 'activePaneId' | 'paneOrientation' | 'panes'>,
  requestedOrientation: PaneSplitOrientation
): boolean {
  return (
    getActivePane(tab) !== null &&
    tab.panes.length < maxTabPaneCount &&
    (tab.paneOrientation === null || tab.paneOrientation === requestedOrientation)
  )
}

function canCloseTabPane(tab: Pick<TabRecord, 'activePaneId' | 'panes'>): boolean {
  return getActivePane(tab) !== null && tab.panes.length > 1
}

function syncTabWithActivePane(tab: TabRecord): TabRecord {
  const activePane = getActivePane(tab)

  if (!activePane) {
    return tab
  }

  const nextRestoreState =
    activePane.restoreState.kind === 'ssh'
      ? {
          ...activePane.restoreState,
          ...(tab.restoreState.kind === 'ssh' && tab.restoreState.browserPath
            ? {
                browserPath: tab.restoreState.browserPath
              }
            : {})
        }
      : cloneRestorableTabState(activePane.restoreState)

  if (tab.activePaneId !== activePane.id) {
    tab = {
      ...tab,
      activePaneId: activePane.id
    }
  }

  return {
    ...tab,
    errorMessage: activePane.errorMessage,
    exitCode: activePane.exitCode,
    outputLines: clonePersistedOutputLines(activePane.outputLines),
    reconnectAttempt: activePane.reconnectAttempt,
    restoreState: nextRestoreState,
    status: activePane.status,
    terminalId: activePane.terminalId,
    title: activePane.title
  }
}

function getDefaultLocalTabCreateOptions(defaultNewTabDirectory: string): CreateTabOptions | null {
  const normalizedDefaultNewTabDirectory = normalizeDefaultNewTabDirectory(defaultNewTabDirectory)

  if (normalizedDefaultNewTabDirectory === '') {
    return null
  }

  return {
    restoreState: {
      cwd: normalizedDefaultNewTabDirectory,
      kind: 'local'
    },
    terminalCreateOptions: {
      cwd: normalizedDefaultNewTabDirectory
    }
  }
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

function createTabRecordFromPane(tabId: string, pane: TabPaneRecord): TabRecord {
  return syncTabWithActivePane({
    ...pane,
    activePaneId: pane.id,
    id: tabId,
    paneOrientation: null,
    panes: [pane]
  })
}

function createTabRecordFromSessionTab(tab: SessionTabSnapshot): TabRecord {
  return createTabRecordFromPane(
    tab.id,
    createPaneRecord(tab.id, {
      outputLines: tab.outputLines,
      restoreState: tab.restoreState,
      title: tab.title
    })
  )
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
  const normalizedPath = path.replace(/[\\/]+$/, '')

  if (
    normalizedPath === '' ||
    normalizedPath === '/' ||
    normalizedPath === '\\' ||
    /^[a-z]:$/i.test(normalizedPath)
  ) {
    return path
  }

  const lastSlashIndex = Math.max(normalizedPath.lastIndexOf('/'), normalizedPath.lastIndexOf('\\'))

  return lastSlashIndex >= 0 ? normalizedPath.slice(lastSlashIndex + 1) : normalizedPath
}

function shouldShowTerminalQuickChmodRunAction(path: string): boolean {
  const fileName = getRemotePathBaseName(path)

  if (fileName === '' || fileName === '.' || fileName === '..') {
    return false
  }

  const normalizedFileName = fileName.toLowerCase()
  return normalizedFileName.endsWith('.sh') || !fileName.includes('.')
}

function getTerminalQuickChmodRunAction(
  terminalItem: Pick<TabPaneRecord, 'restoreState'>,
  selectionText: string
): TerminalQuickChmodRunAction | null {
  if (terminalItem.restoreState.kind === 'local' && usesWindowsShellQuoting()) {
    return null
  }

  const normalizedSelection =
    terminalItem.restoreState.kind === 'ssh'
      ? normalizeTerminalSelectionForRemotePath(selectionText)
      : normalizeTerminalSelectionForArchivePath(selectionText)

  if (
    !normalizedSelection ||
    normalizedSelection === '~' ||
    normalizedSelection.startsWith('~\\')
  ) {
    return null
  }

  let resolvedPath = normalizedSelection

  if (terminalItem.restoreState.kind === 'ssh') {
    if (
      normalizedSelection.startsWith('/') ||
      normalizedSelection.startsWith('~/') ||
      normalizedSelection === '~'
    ) {
      resolvedPath = normalizeRemotePath(normalizedSelection)
    } else if (terminalItem.restoreState.cwd) {
      resolvedPath = normalizeRemotePath(
        joinRemoteDirectoryPath(terminalItem.restoreState.cwd, normalizedSelection)
      )
    }
  } else if (isAbsoluteLocalPath(normalizedSelection)) {
    resolvedPath = normalizedSelection
  } else if (terminalItem.restoreState.cwd) {
    resolvedPath = joinLocalDirectoryPath(terminalItem.restoreState.cwd, normalizedSelection)
  }

  if (!shouldShowTerminalQuickChmodRunAction(resolvedPath)) {
    return null
  }

  const useWindowsQuoting = terminalItem.restoreState.kind === 'local' && usesWindowsShellQuoting()
  const quotedPath = quotePathForShell(resolvedPath, useWindowsQuoting)

  return {
    command: `chmod +x ${quotedPath} && ${quotedPath}`
  }
}

function getSshRemoteEditorSyntaxLanguage(path: string): SshRemoteEditorSyntaxLanguage {
  const normalizedFileName = getRemotePathBaseName(path).toLowerCase()

  if (normalizedFileName === '.env' || normalizedFileName.startsWith('.env.')) {
    return sshRemoteEditorPropertiesLanguage
  }

  if (normalizedFileName === 'dockerfile' || normalizedFileName.startsWith('dockerfile.')) {
    return sshRemoteEditorDockerLanguage
  }

  const exactLanguage = sshRemoteEditorLanguageByExactName.get(normalizedFileName)

  if (exactLanguage) {
    return exactLanguage
  }

  for (const [suffix, language] of sshRemoteEditorLanguageBySuffix) {
    if (normalizedFileName.endsWith(suffix)) {
      return language
    }
  }

  return sshRemoteEditorPlainLanguage
}

function formatDataSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 * 1024 ? 0 : 1)} GB`
}

function getSshUploadProgressTitle(progress: SshUploadProgressEvent): string {
  const progressPercent = Math.round(progress.percent)
  const currentItemName = progress.currentPath ? getRemotePathBaseName(progress.currentPath) : null

  return [
    progress.status === 'completed'
      ? `Upload to ${progress.targetPath} completed`
      : `Uploading to ${progress.targetPath}`,
    `Progress: ${progressPercent}%`,
    `Uploaded: ${formatDataSize(progress.transferredBytes)} / ${formatDataSize(progress.totalBytes)}`,
    currentItemName ? `Current: ${currentItemName}` : null
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function detectSshRemoteEditorLineEnding(content: string): SshRemoteEditorLineEnding {
  if (content.includes('\r\n')) {
    return '\r\n'
  }

  if (content.includes('\r')) {
    return '\r'
  }

  return '\n'
}

function normalizeSshRemoteEditorContent(
  content: string,
  lineEnding: SshRemoteEditorLineEnding
): string {
  const normalizedContent = content.replace(/\r\n?/g, '\n')

  if (lineEnding === '\n') {
    return normalizedContent
  }

  return normalizedContent.replace(/\n/g, lineEnding)
}

function formatSshRemoteEditorLineEnding(lineEnding: SshRemoteEditorLineEnding): string {
  if (lineEnding === '\r\n') {
    return 'CRLF'
  }

  if (lineEnding === '\r') {
    return 'CR'
  }

  return 'LF'
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

function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
}

function joinLocalDirectoryPath(basePath: string, name: string): string {
  const normalizedBasePath = basePath.trim().replace(/[\\/]+$/, '')

  if (normalizedBasePath === '') {
    return name
  }

  const separator =
    normalizedBasePath.includes('\\') || /^[a-z]:$/i.test(normalizedBasePath) ? '\\' : '/'

  return `${normalizedBasePath}${separator}${name.replace(/^[\\/]+/, '')}`
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
  terminalItem: Pick<TabPaneRecord, 'restoreState'>,
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
    terminalItem.restoreState.kind === 'local' && usesWindowsShellQuoting()
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
  terminalItem: Pick<TabPaneRecord, 'restoreState'>,
  selectionText: string
): TerminalQuickDownloadAction | null {
  if (terminalItem.restoreState.kind !== 'ssh') {
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
  } else if (terminalItem.restoreState.cwd) {
    remotePath = normalizeRemotePath(
      joinRemoteDirectoryPath(terminalItem.restoreState.cwd, normalizedSelection)
    )
  }

  if (!remotePath) {
    return null
  }

  if (remotePath === '/' || remotePath === '~') {
    return null
  }

  return {
    configId: terminalItem.restoreState.configId,
    remotePath
  }
}

function getTerminalQuickLocalEditPath(
  terminalItem: Pick<TabPaneRecord, 'restoreState'>,
  selectionText: string
): string | null {
  if (terminalItem.restoreState.kind !== 'local') {
    return null
  }

  const normalizedSelection = normalizeTerminalSelectionForArchivePath(selectionText)

  if (
    !normalizedSelection ||
    normalizedSelection === '~' ||
    normalizedSelection.startsWith('~/') ||
    normalizedSelection.startsWith('~\\')
  ) {
    return null
  }

  const localPath = isAbsoluteLocalPath(normalizedSelection)
    ? normalizedSelection
    : terminalItem.restoreState.cwd
      ? joinLocalDirectoryPath(terminalItem.restoreState.cwd, normalizedSelection)
      : null

  if (!localPath) {
    return null
  }

  return localPath
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

function formatSshBrowserEntrySize(size: number | null): string {
  if (!Number.isFinite(size) || size === null || size < 0) {
    return '--'
  }

  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 * 1024 ? 0 : 1)} GB`
}

function formatSshBrowserEntryTimestamp(timestamp: number | null): string {
  if (!Number.isFinite(timestamp) || timestamp === null || timestamp <= 0) {
    return '--'
  }

  return sshBrowserTimestampFormatter.format(new Date(timestamp))
}

function getSshBrowserEntryKindLabel(entry: SshRemoteDirectoryEntry): string {
  if (entry.type === 'directory') {
    return 'Folder'
  }

  if (entry.type === 'symlink') {
    return 'Link'
  }

  if (entry.type === 'other') {
    return 'Special'
  }

  return 'File'
}

function getSshBrowserEntryFilterText(entry: SshRemoteDirectoryEntry): string {
  return [entry.name, entry.permissions ?? '', getSshBrowserEntryKindLabel(entry)]
    .join(' ')
    .toLowerCase()
}

function getVisibleSshBrowserEntries(
  entries: SshRemoteDirectoryEntry[],
  filterQuery: string
): SshRemoteDirectoryEntry[] {
  const normalizedQuery = filterQuery.trim().toLowerCase()
  const filteredEntries =
    normalizedQuery === ''
      ? entries
      : entries.filter((entry) => getSshBrowserEntryFilterText(entry).includes(normalizedQuery))
  const directoryEntries: SshRemoteDirectoryEntry[] = []
  const fileEntries: SshRemoteDirectoryEntry[] = []

  for (const entry of filteredEntries) {
    if (entry.isDirectory) {
      directoryEntries.push(entry)
      continue
    }

    fileEntries.push(entry)
  }

  return [...directoryEntries, ...fileEntries]
}

function getSshBrowserEntryNameError(name: string): string | null {
  if (name === '') {
    return 'Enter a name before continuing.'
  }

  if (name === '.' || name === '..') {
    return 'Remote entry names cannot be "." or "..".'
  }

  if (name.includes('/')) {
    return 'Remote entry names cannot include "/".'
  }

  return null
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

function canEditSshRemoteFile(entry: SshRemoteDirectoryEntry): boolean {
  if (entry.isDirectory || entry.type === 'symlink' || entry.type === 'other') {
    return false
  }

  const descriptor = getSshBrowserFileIconDescriptor(entry.name)

  return (
    descriptor === sshBrowserCodeFileIconDescriptor ||
    descriptor === sshBrowserScriptFileIconDescriptor ||
    descriptor === sshBrowserTextFileIconDescriptor
  )
}

function getTerminalItemStatusLabel(
  terminalItem: Pick<TabPaneRecord, 'errorMessage' | 'reconnectAttempt' | 'restoreState' | 'status'>
): string {
  if (
    terminalItem.restoreState.kind === 'ssh' &&
    typeof terminalItem.reconnectAttempt === 'number'
  ) {
    return 'Reconnecting'
  }

  if (terminalItem.status === 'connecting') {
    return 'Starting'
  }

  if (terminalItem.errorMessage) {
    return 'Failed'
  }

  return ''
}

function getTabStatusLabel(tab: TabRecord): string {
  const terminalStatusLabel = getTerminalItemStatusLabel(tab)

  if (terminalStatusLabel !== '') {
    return terminalStatusLabel
  }

  if (tab.panes.length > 1) {
    return `${tab.panes.length} panes`
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
  onOpenContextMenu: (event: React.MouseEvent<HTMLButtonElement>, tabId: string) => void
  sshServerIcon?: SshServerIcon | null
  tab: TabRecord
}

function ReorderableTab({
  closeTab,
  index,
  isActive,
  onActivateTab,
  onOpenContextMenu,
  sshServerIcon,
  tab
}: ReorderableTabProps): React.JSX.Element {
  const dragControls = useDragControls()
  const tabStatusLabel = getTabStatusLabel(tab)
  const handleCloseClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    closeTab(tab.id)
  }
  const handleCloseAuxClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (event.button !== 1) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    closeTab(tab.id)
  }

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
        onContextMenu={(event) => onOpenContextMenu(event, tab.id)}
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
        {tab.restoreState.kind === 'ssh' ? (
          <SshServerIconGlyph className="tab-server-icon" icon={sshServerIcon} />
        ) : null}
        <span className="tab-copy">
          <span className="tab-label">{tab.title}</span>
          {tabStatusLabel ? <span className="tab-meta">{tabStatusLabel}</span> : null}
        </span>
      </button>
      <button
        aria-label={`Close tab ${index + 1}`}
        className="tab-close"
        onAuxClick={handleCloseAuxClick}
        onClick={handleCloseClick}
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
    defaultRemoteStartPath: serverConfig.defaultRemoteStartPath,
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

type SshConfigFeedbackTone = 'error' | 'info' | 'success'

interface SettingsDialogProps {
  availableTerminalFontOptions: TerminalFontOption[]
  defaultNewTabDirectory: string
  isSettingsTransferInProgress: boolean
  onClose: () => void
  onDefaultNewTabDirectoryChange: (defaultNewTabDirectory: string) => void
  onExportSettings: () => void
  onImportSettings: () => void
  onQuickCommandsChange: (quickCommands: QuickCommand[]) => void
  onSftpBrowserOpenModeChange: (sftpBrowserOpenMode: SftpBrowserOpenMode) => void
  onStartupModeChange: (startupMode: AppStartupMode) => void
  onTerminalColorSchemeChange: (colorSchemeId: TerminalColorSchemeId) => void
  onTerminalCursorBlinkChange: (cursorBlink: boolean) => void
  onTerminalCursorColorChange: (cursorColor: string | null) => void
  onTerminalSelectionColorChange: (selectionColor: string | null) => void
  onTerminalCursorStyleChange: (cursorStyle: TerminalCursorStyle) => void
  onTerminalCursorWidthChange: (cursorWidth: number) => void
  onTerminalFontFamilyChange: (fontFamilyId: TerminalFontFamilyId) => void
  onTerminalFontSizeChange: (fontSize: number) => void
  onTerminalFontWeightChange: (fontWeight: TerminalFontWeight) => void
  onTerminalLineHeightChange: (lineHeight: number) => void
  quickCommands: QuickCommand[]
  settingsTransferAction: SettingsTransferAction | null
  settingsTransferMessage: string | null
  settingsTransferTone: SettingsTransferTone
  selectedSftpBrowserOpenMode: SftpBrowserOpenMode
  selectedStartupMode: AppStartupMode
  selectedTerminalColorSchemeId: TerminalColorSchemeId
  selectedTerminalCursorBlink: boolean
  selectedTerminalCursorColor: string | null
  selectedTerminalSelectionColor: string | null
  selectedTerminalCursorStyle: TerminalCursorStyle
  selectedTerminalCursorWidth: number
  selectedTerminalFontFamilyId: TerminalFontFamilyId
  selectedTerminalFontSize: number
  selectedTerminalFontWeight: TerminalFontWeight
  selectedTerminalLineHeight: number
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

function GeneralSettingsPanel({
  defaultNewTabDirectory,
  isSettingsTransferInProgress,
  onDefaultNewTabDirectoryChange,
  onExportSettings,
  onImportSettings,
  onSftpBrowserOpenModeChange,
  onStartupModeChange,
  onTerminalCursorBlinkChange,
  onTerminalCursorStyleChange,
  onTerminalCursorWidthChange,
  onTerminalLineHeightChange,
  settingsTransferAction,
  settingsTransferMessage,
  settingsTransferTone,
  selectedSftpBrowserOpenMode,
  selectedStartupMode,
  selectedTerminalCursorBlink,
  selectedTerminalCursorStyle,
  selectedTerminalCursorWidth,
  selectedTerminalLineHeight
}: {
  defaultNewTabDirectory: string
  isSettingsTransferInProgress: boolean
  onDefaultNewTabDirectoryChange: (defaultNewTabDirectory: string) => void
  onExportSettings: () => void
  onImportSettings: () => void
  onSftpBrowserOpenModeChange: (sftpBrowserOpenMode: SftpBrowserOpenMode) => void
  onStartupModeChange: (startupMode: AppStartupMode) => void
  onTerminalCursorBlinkChange: (cursorBlink: boolean) => void
  onTerminalCursorStyleChange: (cursorStyle: TerminalCursorStyle) => void
  onTerminalCursorWidthChange: (cursorWidth: number) => void
  onTerminalLineHeightChange: (lineHeight: number) => void
  settingsTransferAction: SettingsTransferAction | null
  settingsTransferMessage: string | null
  settingsTransferTone: SettingsTransferTone
  selectedSftpBrowserOpenMode: SftpBrowserOpenMode
  selectedStartupMode: AppStartupMode
  selectedTerminalCursorBlink: boolean
  selectedTerminalCursorStyle: TerminalCursorStyle
  selectedTerminalCursorWidth: number
  selectedTerminalLineHeight: number
}): React.JSX.Element {
  return (
    <div className="settings-appearance settings-general">
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">Terminal defaults</h3>
          <p className="settings-color-schemes-note">
            Set the baseline cursor and spacing rules used for every terminal tab. Changes apply to
            open tabs immediately.
          </p>
        </div>
        <div className="settings-general-grid">
          <label className="settings-field">
            <span className="settings-field-label">Cursor style</span>
            <select
              className="settings-field-input"
              onChange={(event) =>
                onTerminalCursorStyleChange(event.target.value as TerminalCursorStyle)
              }
              value={selectedTerminalCursorStyle}
            >
              {terminalCursorStyleOptions.map((cursorStyleOption) => (
                <option key={cursorStyleOption.value} value={cursorStyleOption.value}>
                  {cursorStyleOption.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Blink</span>
            <select
              className="settings-field-input"
              onChange={(event) => onTerminalCursorBlinkChange(event.target.value === 'true')}
              value={String(selectedTerminalCursorBlink)}
            >
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Cursor width</span>
            <input
              className="settings-field-input settings-field-input--native-number"
              disabled={selectedTerminalCursorStyle !== 'bar'}
              max={maxTerminalCursorWidth}
              min={minTerminalCursorWidth}
              onChange={(event) => {
                const nextCursorWidth = Number(event.target.value)

                onTerminalCursorWidthChange(
                  Number.isFinite(nextCursorWidth)
                    ? clampTerminalCursorWidth(nextCursorWidth)
                    : defaultTerminalCursorWidth
                )
              }}
              type="number"
              value={selectedTerminalCursorWidth}
            />
            <span className="settings-field-help">
              Applies when the cursor style is set to bar.
            </span>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Line height</span>
            <input
              className="settings-field-input settings-field-input--native-number"
              max={maxTerminalLineHeight}
              min={minTerminalLineHeight}
              onChange={(event) => {
                const nextLineHeight = Number(event.target.value)

                onTerminalLineHeightChange(
                  Number.isFinite(nextLineHeight)
                    ? clampTerminalLineHeight(nextLineHeight)
                    : defaultTerminalLineHeight
                )
              }}
              step="0.05"
              type="number"
              value={selectedTerminalLineHeight}
            />
          </label>
        </div>
      </div>
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">Startup</h3>
          <p className="settings-color-schemes-note">
            Control how the app opens and where new local tabs start.
          </p>
        </div>
        <div className="settings-general-grid">
          <label className="settings-field">
            <span className="settings-field-label">On launch</span>
            <select
              className="settings-field-input"
              onChange={(event) => onStartupModeChange(event.target.value as AppStartupMode)}
              value={selectedStartupMode}
            >
              {appStartupModeOptions.map((startupModeOption) => (
                <option key={startupModeOption.value} value={startupModeOption.value}>
                  {startupModeOption.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field is-full-width">
            <span className="settings-field-label">Default new tab directory</span>
            <input
              className="settings-field-input"
              onChange={(event) => onDefaultNewTabDirectoryChange(event.target.value)}
              placeholder="/path/to/directory"
              type="text"
              value={defaultNewTabDirectory}
            />
            <span className="settings-field-help">
              Leave blank to use the shell default. Invalid paths fall back automatically.
            </span>
          </label>
        </div>
      </div>
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">SFTP browser</h3>
          <p className="settings-color-schemes-note">
            Choose which remote folder opens when you open the SFTP browser from an SSH tab.
          </p>
        </div>
        <div className="settings-general-grid">
          <label className="settings-field">
            <span className="settings-field-label">Open with</span>
            <select
              className="settings-field-input"
              onChange={(event) =>
                onSftpBrowserOpenModeChange(event.target.value as SftpBrowserOpenMode)
              }
              value={selectedSftpBrowserOpenMode}
            >
              {sftpBrowserOpenModeOptions.map((sftpBrowserOpenModeOption) => (
                <option
                  key={sftpBrowserOpenModeOption.value}
                  value={sftpBrowserOpenModeOption.value}
                >
                  {sftpBrowserOpenModeOption.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">Import and export</h3>
          <p className="settings-color-schemes-note">
            Export your current setup to a JSON file or import a saved backup. Importing replaces
            the current settings immediately.
          </p>
        </div>
        <div className="settings-transfer-actions">
          <button
            className="settings-transfer-button"
            disabled={isSettingsTransferInProgress}
            onClick={onImportSettings}
            type="button"
          >
            <Upload aria-hidden="true" className="settings-transfer-button-icon" />
            <span>{settingsTransferAction === 'import' ? 'Importing...' : 'Import settings'}</span>
          </button>
          <button
            className="settings-transfer-button"
            disabled={isSettingsTransferInProgress}
            onClick={onExportSettings}
            type="button"
          >
            <Download aria-hidden="true" className="settings-transfer-button-icon" />
            <span>{settingsTransferAction === 'export' ? 'Exporting...' : 'Export settings'}</span>
          </button>
        </div>
        {settingsTransferMessage ? (
          <p className={`settings-transfer-status is-${settingsTransferTone}`}>
            {settingsTransferMessage}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function TerminalPreviewCursor({
  cursorStyle,
  cursorWidth
}: {
  cursorStyle: TerminalCursorStyle
  cursorWidth: number
}): React.JSX.Element {
  if (cursorStyle === 'block') {
    return (
      <span
        aria-hidden="true"
        className="settings-color-scheme-preview-cursor settings-color-scheme-preview-cursor--block"
      >
        A
      </span>
    )
  }

  if (cursorStyle === 'underline') {
    return (
      <span
        aria-hidden="true"
        className="settings-color-scheme-preview-cursor settings-color-scheme-preview-cursor--underline"
      >
        {'\u00a0'}
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className="settings-color-scheme-preview-cursor settings-color-scheme-preview-cursor--bar"
      style={
        {
          '--settings-preview-cursor-width': `${cursorWidth}px`
        } as CSSProperties
      }
    />
  )
}

function AppearanceSettingsPanel({
  availableTerminalFontOptions,
  onTerminalColorSchemeChange,
  onTerminalCursorColorChange,
  onTerminalSelectionColorChange,
  onTerminalFontFamilyChange,
  onTerminalFontSizeChange,
  onTerminalFontWeightChange,
  selectedTerminalColorSchemeId,
  selectedTerminalCursorColor,
  selectedTerminalSelectionColor,
  selectedTerminalCursorStyle,
  selectedTerminalCursorWidth,
  selectedTerminalFontFamilyId,
  selectedTerminalFontSize,
  selectedTerminalFontWeight,
  selectedTerminalLineHeight
}: {
  availableTerminalFontOptions: TerminalFontOption[]
  onTerminalColorSchemeChange: (colorSchemeId: TerminalColorSchemeId) => void
  onTerminalCursorColorChange: (cursorColor: string | null) => void
  onTerminalSelectionColorChange: (selectionColor: string | null) => void
  onTerminalFontFamilyChange: (fontFamilyId: TerminalFontFamilyId) => void
  onTerminalFontSizeChange: (fontSize: number) => void
  onTerminalFontWeightChange: (fontWeight: TerminalFontWeight) => void
  selectedTerminalColorSchemeId: TerminalColorSchemeId
  selectedTerminalCursorColor: string | null
  selectedTerminalSelectionColor: string | null
  selectedTerminalCursorStyle: TerminalCursorStyle
  selectedTerminalCursorWidth: number
  selectedTerminalFontFamilyId: TerminalFontFamilyId
  selectedTerminalFontSize: number
  selectedTerminalFontWeight: TerminalFontWeight
  selectedTerminalLineHeight: number
}): React.JSX.Element {
  const selectedTerminalColorScheme =
    terminalColorSchemesById.get(selectedTerminalColorSchemeId) ?? defaultTerminalColorScheme
  const selectedTerminalFontOption =
    availableTerminalFontOptions.find(
      (fontOption) => fontOption.id === selectedTerminalFontFamilyId
    ) ?? defaultTerminalFontOption
  const selectedTerminalTheme = getConfiguredTerminalTheme(
    selectedTerminalColorScheme.theme,
    selectedTerminalCursorColor,
    selectedTerminalSelectionColor
  )
  const selectedCursorColorInputValue =
    normalizeTerminalCursorColor(selectedTerminalTheme.cursor) ??
    normalizeTerminalCursorColor(selectedTerminalColorScheme.theme.cursor) ??
    normalizeTerminalCursorColor(defaultTerminalTheme.cursor) ??
    '#f5f5f5'
  const selectedSelectionColorInputValue =
    normalizeTerminalSelectionColor(selectedTerminalSelectionColor) ??
    getHexColorInputValue(selectedTerminalColorScheme.theme.selectionBackground, '#7aa2f7')
  const previewStyle = {
    '--settings-scheme-accent':
      selectedTerminalColorScheme.theme.blue ??
      selectedTerminalTheme.cursor ??
      selectedTerminalTheme.foreground,
    '--settings-scheme-background': selectedTerminalTheme.background ?? '#000000',
    '--settings-scheme-cursor': selectedTerminalTheme.cursor ?? selectedTerminalTheme.foreground,
    '--settings-scheme-cursor-accent':
      selectedTerminalTheme.cursorAccent ?? selectedTerminalTheme.background ?? '#000000',
    '--settings-scheme-foreground': selectedTerminalTheme.foreground ?? '#ffffff',
    '--settings-scheme-muted':
      selectedTerminalTheme.brightBlack ?? selectedTerminalTheme.black ?? '#4c566a',
    '--settings-scheme-selection-background':
      selectedTerminalTheme.selectionBackground ?? 'rgba(255, 255, 255, 0.18)',
    '--settings-scheme-selection-foreground':
      selectedTerminalTheme.selectionForeground ?? selectedTerminalTheme.foreground ?? '#ffffff',
    '--settings-preview-font-family': selectedTerminalFontOption.fontFamily,
    '--settings-preview-line-height': selectedTerminalLineHeight,
    '--settings-preview-font-size': `${selectedTerminalFontSize}px`,
    '--settings-preview-font-weight': selectedTerminalFontWeight
  } as CSSProperties

  return (
    <div className="settings-appearance">
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">Typography</h3>
          <p className="settings-color-schemes-note">
            Choose the terminal font family, size, and weight. Changes apply to open tabs
            immediately and stay saved on this device.
          </p>
        </div>
        <div className="settings-appearance-controls">
          <label className="settings-field">
            <span className="settings-field-label">Font</span>
            <select
              className="settings-field-input"
              onChange={(event) =>
                onTerminalFontFamilyChange(event.target.value as TerminalFontFamilyId)
              }
              value={selectedTerminalFontFamilyId}
            >
              {availableTerminalFontOptions.map((fontOption) => (
                <option key={fontOption.id} value={fontOption.id}>
                  {fontOption.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Font size</span>
            <input
              className="settings-field-input"
              max={maxTerminalFontSize}
              min={minTerminalFontSize}
              onChange={(event) => {
                const nextFontSize = Number(event.target.value)

                onTerminalFontSizeChange(
                  Number.isFinite(nextFontSize)
                    ? clampTerminalFontSize(nextFontSize)
                    : defaultTerminalFontSize
                )
              }}
              type="number"
              value={selectedTerminalFontSize}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Font weight</span>
            <select
              className="settings-field-input"
              onChange={(event) =>
                onTerminalFontWeightChange(event.target.value as TerminalFontWeight)
              }
              value={selectedTerminalFontWeight}
            >
              {terminalFontWeightOptions.map((fontWeightOption) => (
                <option key={fontWeightOption.value} value={fontWeightOption.value}>
                  {fontWeightOption.label} - {fontWeightOption.description}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="settings-appearance-preview" style={previewStyle}>
          <div className="settings-color-scheme-preview-toolbar">
            <span className="settings-color-scheme-preview-dot" />
            <span className="settings-color-scheme-preview-dot" />
            <span className="settings-color-scheme-preview-dot" />
          </div>
          <div className="settings-color-scheme-preview-body">
            <span className="settings-color-scheme-preview-line">
              mustafa@terminal <span className="settings-color-scheme-preview-path">~/project</span>
            </span>
            <span className="settings-color-scheme-preview-line">
              $ npm run dev
              <TerminalPreviewCursor
                cursorStyle={selectedTerminalCursorStyle}
                cursorWidth={selectedTerminalCursorWidth}
              />
            </span>
            <span className="settings-color-scheme-preview-line is-muted">
              watching <span className="settings-color-scheme-preview-selection">for changes</span>
            </span>
          </div>
        </div>
      </div>
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">Cursor and selection</h3>
          <p className="settings-color-schemes-note">
            Keep the cursor and text selection on palette defaults or pin both to fixed colors.
          </p>
        </div>
        <div className="settings-appearance-controls settings-appearance-controls--compact">
          <label className="settings-field">
            <span className="settings-field-label">Cursor</span>
            <span className="settings-field-label settings-field-label--sr-only">Cursor color</span>
            <div className="settings-inline-control">
              <input
                aria-label="Cursor color"
                className="settings-field-input settings-field-input--color"
                disabled={selectedTerminalCursorColor === null}
                onChange={(event) =>
                  onTerminalCursorColorChange(
                    normalizeTerminalCursorColor(event.target.value) ??
                      selectedCursorColorInputValue
                  )
                }
                type="color"
                value={selectedCursorColorInputValue}
              />
              <select
                className="settings-field-input"
                onChange={(event) => {
                  if (event.target.value === 'custom') {
                    onTerminalCursorColorChange(
                      selectedTerminalCursorColor ?? selectedCursorColorInputValue
                    )
                    return
                  }

                  onTerminalCursorColorChange(null)
                }}
                value={selectedTerminalCursorColor ? 'custom' : 'palette'}
              >
                <option value="palette">Use palette default</option>
                <option value="custom">Use custom color</option>
              </select>
            </div>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Selection</span>
            <span className="settings-field-label settings-field-label--sr-only">
              Selection color
            </span>
            <div className="settings-inline-control">
              <input
                aria-label="Selection color"
                className="settings-field-input settings-field-input--color"
                disabled={selectedTerminalSelectionColor === null}
                onChange={(event) =>
                  onTerminalSelectionColorChange(
                    normalizeTerminalSelectionColor(event.target.value) ??
                      selectedSelectionColorInputValue
                  )
                }
                type="color"
                value={selectedSelectionColorInputValue}
              />
              <select
                className="settings-field-input"
                onChange={(event) => {
                  if (event.target.value === 'custom') {
                    onTerminalSelectionColorChange(
                      selectedTerminalSelectionColor ?? selectedSelectionColorInputValue
                    )
                    return
                  }

                  onTerminalSelectionColorChange(null)
                }}
                value={selectedTerminalSelectionColor ? 'custom' : 'palette'}
              >
                <option value="palette">Use palette default</option>
                <option value="custom">Use custom color</option>
              </select>
            </div>
          </label>
        </div>
      </div>
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">Color scheme</h3>
          <p className="settings-color-schemes-note">
            Pick a terminal palette. Changes apply to open tabs immediately and stay saved on this
            device.
          </p>
        </div>
        <div className="settings-color-scheme-grid">
          {terminalColorSchemes.map((colorScheme) => {
            const isSelected = colorScheme.id === selectedTerminalColorSchemeId
            const configuredColorSchemeTheme = getConfiguredTerminalTheme(
              colorScheme.theme,
              selectedTerminalCursorColor,
              selectedTerminalSelectionColor
            )
            const colorSchemePreviewStyle = {
              '--settings-scheme-accent':
                colorScheme.theme.blue ??
                configuredColorSchemeTheme.cursor ??
                configuredColorSchemeTheme.foreground,
              '--settings-scheme-background': configuredColorSchemeTheme.background ?? '#000000',
              '--settings-scheme-cursor':
                configuredColorSchemeTheme.cursor ?? configuredColorSchemeTheme.foreground,
              '--settings-scheme-cursor-accent':
                configuredColorSchemeTheme.cursorAccent ??
                configuredColorSchemeTheme.background ??
                '#000000',
              '--settings-scheme-foreground': configuredColorSchemeTheme.foreground ?? '#ffffff',
              '--settings-scheme-muted':
                configuredColorSchemeTheme.brightBlack ??
                configuredColorSchemeTheme.black ??
                '#4c566a',
              '--settings-scheme-selection-background':
                configuredColorSchemeTheme.selectionBackground ?? 'rgba(255, 255, 255, 0.18)',
              '--settings-scheme-selection-foreground':
                configuredColorSchemeTheme.selectionForeground ??
                configuredColorSchemeTheme.foreground ??
                '#ffffff',
              '--settings-preview-font-family': selectedTerminalFontOption.fontFamily,
              '--settings-preview-line-height': selectedTerminalLineHeight,
              '--settings-preview-font-size': `${selectedTerminalFontSize}px`,
              '--settings-preview-font-weight': selectedTerminalFontWeight
            } as CSSProperties
            const previewColors = [
              colorScheme.theme.red ?? '#ff7b72',
              colorScheme.theme.yellow ?? '#e6c15a',
              colorScheme.theme.green ?? '#8fe388',
              colorScheme.theme.blue ?? '#7aa2f7',
              colorScheme.theme.magenta ?? '#c792ea',
              colorScheme.theme.cyan ?? '#63d3ff'
            ]

            return (
              <button
                aria-pressed={isSelected}
                className={`settings-color-scheme-card${isSelected ? ' is-selected' : ''}`}
                key={colorScheme.id}
                onClick={() => onTerminalColorSchemeChange(colorScheme.id)}
                type="button"
              >
                <div className="settings-color-scheme-card-header">
                  <div className="settings-color-scheme-copy">
                    <span className="settings-color-scheme-name">{colorScheme.label}</span>
                    <span className="settings-color-scheme-description">
                      {colorScheme.description}
                    </span>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`settings-color-scheme-indicator${isSelected ? ' is-selected' : ''}`}
                  >
                    {isSelected ? <Check className="settings-color-scheme-indicator-icon" /> : null}
                  </span>
                </div>
                <div className="settings-color-scheme-preview" style={colorSchemePreviewStyle}>
                  <div className="settings-color-scheme-preview-toolbar">
                    <span className="settings-color-scheme-preview-dot" />
                    <span className="settings-color-scheme-preview-dot" />
                    <span className="settings-color-scheme-preview-dot" />
                  </div>
                  <div className="settings-color-scheme-preview-body">
                    <span className="settings-color-scheme-preview-line">
                      mustafa@terminal{' '}
                      <span className="settings-color-scheme-preview-path">~/app</span>
                    </span>
                    <span className="settings-color-scheme-preview-line">
                      $ npm run dev
                      <TerminalPreviewCursor
                        cursorStyle={selectedTerminalCursorStyle}
                        cursorWidth={selectedTerminalCursorWidth}
                      />
                    </span>
                    <span className="settings-color-scheme-preview-line is-muted">
                      vite{' '}
                      <span className="settings-color-scheme-preview-selection">
                        ready in 420ms
                      </span>
                    </span>
                  </div>
                </div>
                <div className="settings-color-scheme-swatches">
                  {previewColors.map((color, index) => (
                    <span
                      className="settings-color-scheme-swatch"
                      key={`${colorScheme.id}-${index}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function QuickCommandsSettingsPanel({
  onQuickCommandsChange,
  quickCommands
}: {
  onQuickCommandsChange: (quickCommands: QuickCommand[]) => void
  quickCommands: QuickCommand[]
}): React.JSX.Element {
  const [draft, setDraft] = useState<QuickCommandDraft>(() => createQuickCommandDraft())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<QuickCommandDraft>(() =>
    createQuickCommandDraft()
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const activeEditingId =
    editingId && quickCommands.some((quickCommand) => quickCommand.id === editingId)
      ? editingId
      : null

  const handleDraftChange = useCallback((field: keyof QuickCommandDraft, value: string): void => {
    setDraft((currentDraft) => ({
      ...currentDraft,
      [field]: value
    }))
    setErrorMessage(null)
  }, [])

  const handleEditingDraftChange = useCallback(
    (field: keyof QuickCommandDraft, value: string): void => {
      setEditingDraft((currentDraft) => ({
        ...currentDraft,
        [field]: value
      }))
      setErrorMessage(null)
    },
    []
  )

  const handleAddQuickCommand = useCallback((): void => {
    const title = normalizeQuickCommandTitle(draft.title)
    const command = normalizeQuickCommandCommand(draft.command)

    if (title === '' || command === '') {
      setErrorMessage('Add both a title and a command.')
      return
    }

    onQuickCommandsChange([
      ...quickCommands,
      {
        command,
        id: createQuickCommandId(),
        title
      }
    ])
    setDraft(createQuickCommandDraft())
    setErrorMessage(null)
  }, [draft, onQuickCommandsChange, quickCommands])

  const handleStartEditing = useCallback((quickCommand: QuickCommand): void => {
    setEditingId(quickCommand.id)
    setEditingDraft({
      command: quickCommand.command,
      title: quickCommand.title
    })
    setErrorMessage(null)
  }, [])

  const handleCancelEditing = useCallback((): void => {
    setEditingId(null)
    setEditingDraft(createQuickCommandDraft())
    setErrorMessage(null)
  }, [])

  const handleSaveQuickCommand = useCallback((): void => {
    if (!activeEditingId) {
      return
    }

    const title = normalizeQuickCommandTitle(editingDraft.title)
    const command = normalizeQuickCommandCommand(editingDraft.command)

    if (title === '' || command === '') {
      setErrorMessage('Add both a title and a command before saving.')
      return
    }

    onQuickCommandsChange(
      quickCommands.map((quickCommand) =>
        quickCommand.id === activeEditingId
          ? {
              ...quickCommand,
              command,
              title
            }
          : quickCommand
      )
    )
    setEditingId(null)
    setEditingDraft(createQuickCommandDraft())
    setErrorMessage(null)
  }, [activeEditingId, editingDraft, onQuickCommandsChange, quickCommands])

  const handleDeleteQuickCommand = useCallback(
    (quickCommand: QuickCommand): void => {
      const shouldDelete = window.confirm(`Delete quick command "${quickCommand.title}"?`)

      if (!shouldDelete) {
        return
      }

      onQuickCommandsChange(
        quickCommands.filter((currentQuickCommand) => currentQuickCommand.id !== quickCommand.id)
      )

      if (activeEditingId === quickCommand.id) {
        setEditingId(null)
        setEditingDraft(createQuickCommandDraft())
      }

      setErrorMessage(null)
    },
    [activeEditingId, onQuickCommandsChange, quickCommands]
  )

  return (
    <div className="settings-appearance settings-quick-commands">
      <div className="settings-appearance-section">
        <div className="settings-appearance-copy">
          <h3 className="settings-appearance-title">Quick commands</h3>
          <p className="settings-color-schemes-note">
            Save reusable shell snippets here. Each command stays on this device and can be updated
            later from the same table.
          </p>
        </div>
        <div className="settings-table-shell">
          <table className="settings-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Command</th>
                <th className="settings-table-actions-heading" scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="settings-table-row settings-table-row--editor">
                <td>
                  <input
                    aria-label="Quick command title"
                    className="settings-field-input settings-table-input"
                    onChange={(event) => handleDraftChange('title', event.target.value)}
                    placeholder="Restart API"
                    type="text"
                    value={draft.title}
                  />
                </td>
                <td>
                  <input
                    aria-label="Quick command"
                    className="settings-field-input settings-table-input settings-table-input--command"
                    onChange={(event) => handleDraftChange('command', event.target.value)}
                    placeholder="npm run dev"
                    type="text"
                    value={draft.command}
                  />
                </td>
                <td className="settings-table-actions-cell">
                  <div className="settings-table-actions">
                    <button
                      className="settings-table-action-button is-primary"
                      onClick={handleAddQuickCommand}
                      type="button"
                    >
                      <CirclePlus aria-hidden="true" className="settings-table-action-icon" />
                      Add
                    </button>
                  </div>
                </td>
              </tr>
              {quickCommands.length === 0 ? (
                <tr>
                  <td className="settings-table-empty-cell" colSpan={3}>
                    <p className="settings-table-empty">No quick commands saved yet.</p>
                  </td>
                </tr>
              ) : (
                quickCommands.map((quickCommand) => {
                  const isEditing = quickCommand.id === activeEditingId

                  return (
                    <tr className="settings-table-row" key={quickCommand.id}>
                      <td>
                        {isEditing ? (
                          <input
                            aria-label={`Edit title for ${quickCommand.title}`}
                            className="settings-field-input settings-table-input"
                            onChange={(event) =>
                              handleEditingDraftChange('title', event.target.value)
                            }
                            type="text"
                            value={editingDraft.title}
                          />
                        ) : (
                          <span className="settings-table-title">{quickCommand.title}</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            aria-label={`Edit command for ${quickCommand.title}`}
                            className="settings-field-input settings-table-input settings-table-input--command"
                            onChange={(event) =>
                              handleEditingDraftChange('command', event.target.value)
                            }
                            type="text"
                            value={editingDraft.command}
                          />
                        ) : (
                          <code className="settings-table-command">{quickCommand.command}</code>
                        )}
                      </td>
                      <td className="settings-table-actions-cell">
                        <div className="settings-table-actions">
                          {isEditing ? (
                            <>
                              <button
                                className="settings-table-action-button is-primary"
                                onClick={handleSaveQuickCommand}
                                type="button"
                              >
                                <Check aria-hidden="true" className="settings-table-action-icon" />
                                Save
                              </button>
                              <button
                                className="settings-table-action-button"
                                onClick={handleCancelEditing}
                                type="button"
                              >
                                <X aria-hidden="true" className="settings-table-action-icon" />
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                aria-label={`Edit ${quickCommand.title}`}
                                className="settings-table-action-button is-icon-only"
                                onClick={() => handleStartEditing(quickCommand)}
                                title="Edit quick command"
                                type="button"
                              >
                                <Pencil aria-hidden="true" className="settings-table-action-icon" />
                              </button>
                              <button
                                aria-label={`Delete ${quickCommand.title}`}
                                className="settings-table-action-button is-danger is-icon-only"
                                onClick={() => handleDeleteQuickCommand(quickCommand)}
                                title="Delete quick command"
                                type="button"
                              >
                                <Trash2 aria-hidden="true" className="settings-table-action-icon" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {errorMessage ? <p className="settings-table-error">{errorMessage}</p> : null}
      </div>
    </div>
  )
}

function SshConfigDialog({ onClose, serverConfig }: SshConfigDialogProps): React.JSX.Element {
  const isEditing = serverConfig !== null
  const dialogTitle = isEditing ? 'Edit server' : 'Add server'
  const [formState, setFormState] = useState<SshServerConfigInput>(() =>
    createSshConfigFormState(serverConfig)
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isRemovingKnownHosts, setIsRemovingKnownHosts] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [knownHostsFeedback, setKnownHostsFeedback] = useState<{
    message: string
    tone: SshConfigFeedbackTone
  } | null>(null)
  const [isOtherSettingsOpen, setIsOtherSettingsOpen] = useState(() =>
    Boolean(
      serverConfig?.defaultRemoteStartPath ||
      serverConfig?.description ||
      serverConfig?.privateKeyPath
    )
  )
  const connectionNameInputId = useId()
  const sshKeyFileInputRef = useRef<HTMLInputElement>(null)
  const isBusy = isDeleting || isRemovingKnownHosts || isSaving

  const updateField = useCallback(function updateField<TField extends keyof SshServerConfigInput>(
    field: TField,
    value: SshServerConfigInput[TField]
  ): void {
    setFormState((currentState) => ({
      ...currentState,
      [field]: value
    }))
    setErrorMessage(null)
    setKnownHostsFeedback(null)
  }, [])

  const updateAuthMethod = useCallback((authMethod: SshAuthMethod): void => {
    setFormState((currentState) => ({
      ...currentState,
      authMethod,
      password: authMethod === 'password' ? currentState.password : ''
    }))
    setErrorMessage(null)
    setKnownHostsFeedback(null)
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

  const handleRemoveKnownHosts = useCallback(async (): Promise<void> => {
    if (!isEditing || isBusy) {
      return
    }

    const normalizedHost = formState.host.trim()

    if (normalizedHost === '') {
      setKnownHostsFeedback({
        message: 'Add a host before removing known_hosts entries.',
        tone: 'error'
      })
      return
    }

    setErrorMessage(null)
    setKnownHostsFeedback(null)
    setIsRemovingKnownHosts(true)

    try {
      const result = await window.api.ssh.removeKnownHosts(normalizedHost, formState.port)
      const removedTargets = result.removedHosts

      setKnownHostsFeedback(
        removedTargets.length > 0
          ? {
              message: `Removed known_hosts entries for ${removedTargets.join(', ')}.`,
              tone: 'success'
            }
          : {
              message: `No known_hosts entries found for ${normalizedHost}.`,
              tone: 'info'
            }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setKnownHostsFeedback({
        message: message || `Unable to remove known_hosts entries for ${normalizedHost}.`,
        tone: 'error'
      })
    } finally {
      setIsRemovingKnownHosts(false)
    }
  }, [formState.host, formState.port, isBusy, isEditing])

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()

      const normalizedFormState: SshServerConfigInput = {
        ...formState,
        defaultRemoteStartPath: formState.defaultRemoteStartPath.trim(),
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
      contentLabel={dialogTitle}
      isOpen
      onRequestClose={handleCancel}
      overlayClassName="ssh-config-dialog-shell"
      shouldCloseOnEsc={!isBusy}
      shouldCloseOnOverlayClick={!isBusy}
    >
      <div className="ssh-config-header">
        <div className="ssh-config-header-main">
          <h2 className="ssh-config-title" id="ssh-config-title">
            {dialogTitle}
          </h2>
        </div>
        <button
          aria-label="Close server dialog"
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
              disabled={isBusy}
              onClick={() => updateAuthMethod('privateKey')}
              role="radio"
              type="button"
            >
              Private key
            </button>
            <button
              aria-checked={formState.authMethod === 'password'}
              className={`ssh-auth-option${formState.authMethod === 'password' ? ' is-active' : ''}`}
              disabled={isBusy}
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
            <span className="ssh-config-disclosure-title">Other settings</span>
            <ChevronDown
              aria-hidden="true"
              className={`ssh-config-disclosure-icon${isOtherSettingsOpen ? ' is-open' : ''}`}
            />
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
                <span className="ssh-field-label">Default remote start path</span>
                <input
                  className="ssh-field-input"
                  onChange={(event) => updateField('defaultRemoteStartPath', event.target.value)}
                  placeholder="~/project"
                  type="text"
                  value={formState.defaultRemoteStartPath}
                />
                <span className="ssh-field-help">
                  Leave blank to use the remote shell default when opening new SSH tabs.
                </span>
              </label>
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
              {isEditing ? (
                <div className="ssh-field">
                  <span className="ssh-field-label">Known hosts</span>
                  <div className="ssh-field-inline-action-row">
                    <button
                      className="ssh-field-inline-action"
                      disabled={isBusy || formState.host.trim() === ''}
                      onClick={() => void handleRemoveKnownHosts()}
                      type="button"
                    >
                      <BrushCleaning aria-hidden="true" className="ssh-field-inline-action-icon" />
                      <span>{isRemovingKnownHosts ? 'Cleaning...' : 'Clean known_hosts'}</span>
                    </button>
                    <span className="ssh-field-help">
                      Remove saved host keys before reconnecting to a rebuilt or re-keyed server.
                    </span>
                  </div>
                  {knownHostsFeedback ? (
                    <span
                      aria-live="polite"
                      className={`ssh-field-status is-${knownHostsFeedback.tone}`}
                    >
                      {knownHostsFeedback.message}
                    </span>
                  ) : null}
                </div>
              ) : null}
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
              {isDeleting ? 'Deleting...' : 'Delete server'}
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
            {isSaving ? 'Saving...' : isEditing ? 'Save changes' : 'Create server'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface SshRemoteEditorDialogProps {
  editorState: SshRemoteEditorState
  onChangeContent: (content: string) => void
  onClose: () => void
  onReset: () => void
  onSave: () => void
}

interface SshRemoteEditorLoadingDialogProps {
  loadingState: SshRemoteEditorLoadingState
}

interface SshBrowserCreateDialogProps {
  browserState: SshBrowserState
  draftState: SshBrowserCreateDialogState
  onChangeName: (name: string) => void
  onClose: () => void
  onSubmit: () => void
}

function SshRemoteEditorLoadingDialog({
  loadingState
}: SshRemoteEditorLoadingDialogProps): React.JSX.Element {
  return (
    <Modal
      appElement={document.getElementById('root') ?? undefined}
      bodyOpenClassName="ssh-config-modal-open"
      className="remote-editor-loading-dialog"
      contentLabel={`Opening ${loadingState.fileName}`}
      isOpen
      overlayClassName="remote-editor-dialog-shell"
      shouldCloseOnEsc={false}
      shouldCloseOnOverlayClick={false}
    >
      <div className="remote-editor-loading-card">
        <div aria-hidden="true" className="remote-editor-loading-indicator" />
        <div className="remote-editor-loading-copy">
          <h2 className="remote-editor-loading-title">Opening editor</h2>
          <p className="remote-editor-loading-path" title={loadingState.path}>
            {loadingState.path}
          </p>
        </div>
      </div>
    </Modal>
  )
}

function SshBrowserCreateDialog({
  browserState,
  draftState,
  onChangeName,
  onClose,
  onSubmit
}: SshBrowserCreateDialogProps): React.JSX.Element {
  const titleId = useId()
  const pathId = `${titleId}-path`
  const DialogIcon = draftState.isDirectory ? FolderPlus : FilePlus
  const dialogTitle = draftState.isDirectory ? 'New folder' : 'New file'
  const submitLabel = draftState.isDirectory ? 'Create folder' : 'Create file'

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault()
      onSubmit()
    },
    [onSubmit]
  )

  return (
    <Modal
      appElement={document.getElementById('root') ?? undefined}
      aria={{
        describedby: pathId,
        labelledby: titleId
      }}
      bodyOpenClassName="ssh-config-modal-open"
      className="ssh-browser-create-dialog"
      contentLabel={dialogTitle}
      isOpen
      onRequestClose={onClose}
      overlayClassName="remote-editor-dialog-shell"
      shouldCloseOnEsc
      shouldCloseOnOverlayClick
    >
      <form className="ssh-browser-create-form" onSubmit={handleSubmit}>
        <div className="ssh-browser-create-header">
          <div className="ssh-browser-create-copy">
            <div className="ssh-browser-create-title-row">
              <DialogIcon aria-hidden="true" className="ssh-browser-create-title-icon" />
              <h2 className="ssh-browser-create-title" id={titleId}>
                {dialogTitle}
              </h2>
            </div>
            <p className="ssh-browser-create-path" id={pathId} title={browserState.path ?? ''}>
              {browserState.path ?? 'Remote folder unavailable'}
            </p>
          </div>
          <button
            aria-label="Close create dialog"
            className="ssh-browser-create-dismiss"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="ssh-browser-create-dismiss-icon" />
          </button>
        </div>
        <div className="ssh-browser-create-body">
          <label className="settings-field">
            <span className="settings-field-label">Name</span>
            <input
              autoFocus
              className="settings-field-input"
              onChange={(event) => onChangeName(event.target.value)}
              placeholder={draftState.isDirectory ? 'logs' : 'notes.txt'}
              type="text"
              value={draftState.name}
            />
          </label>
          {draftState.errorMessage ? (
            <p className="ssh-browser-create-error">{draftState.errorMessage}</p>
          ) : null}
        </div>
        <div className="ssh-browser-create-actions">
          <button className="ssh-browser-create-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="ssh-browser-create-button is-primary" type="submit">
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function SshRemoteEditorDialog({
  editorState,
  onChangeContent,
  onClose,
  onReset,
  onSave
}: SshRemoteEditorDialogProps): React.JSX.Element {
  const titleId = useId()
  const pathId = `${titleId}-path`
  const fileName = getRemotePathBaseName(editorState.path)
  const editorLanguage = getSshRemoteEditorSyntaxLanguage(editorState.path)
  const isDirty = editorState.content !== editorState.initialContent
  const lineCount = editorState.content === '' ? 1 : editorState.content.split(/\r\n|\r|\n/).length
  const editorExtensions = useMemo(
    () => [
      ...sshRemoteEditorBaseExtensions,
      ...editorLanguage.extensions,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSave()
            return true
          }
        }
      ])
    ],
    [editorLanguage.extensions, onSave]
  )

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault()
      onSave()
    },
    [onSave]
  )

  return (
    <Modal
      appElement={document.getElementById('root') ?? undefined}
      aria={{
        describedby: pathId,
        labelledby: titleId
      }}
      bodyOpenClassName="ssh-config-modal-open"
      className="remote-editor-dialog"
      contentLabel={`Edit ${fileName}`}
      isOpen
      onRequestClose={onClose}
      overlayClassName="remote-editor-dialog-shell"
      shouldCloseOnEsc={!editorState.isSaving}
      shouldCloseOnOverlayClick={!editorState.isSaving}
    >
      <form className="remote-editor-form" onSubmit={handleSubmit}>
        <div className="remote-editor-header">
          <div className="remote-editor-heading">
            <div className="remote-editor-title-row">
              <FileText aria-hidden="true" className="remote-editor-title-icon" />
              <h2 className="remote-editor-title" id={titleId}>
                {fileName}
              </h2>
            </div>
            <p className="remote-editor-path" id={pathId} title={editorState.path}>
              {editorState.path}
            </p>
          </div>
          <button
            aria-label="Close editor"
            className="remote-editor-dismiss"
            disabled={editorState.isSaving}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="remote-editor-dismiss-icon" />
          </button>
        </div>
        <div className="remote-editor-meta">
          <span>{formatDataSize(editorState.size)}</span>
          <span>{lineCount} lines</span>
          <span>{editorLanguage.label}</span>
          <span>{formatSshRemoteEditorLineEnding(editorState.lineEnding)}</span>
          <span>{isDirty ? 'Unsaved changes' : 'Saved'}</span>
          <span>Ctrl/Cmd+S to save</span>
        </div>
        <div className="remote-editor-body">
          <div className="remote-editor-stage">
            <CodeMirror
              autoFocus
              basicSetup={{
                foldGutter: false
              }}
              className="remote-editor-codemirror"
              editable={!editorState.isSaving}
              extensions={editorExtensions}
              height="100%"
              indentWithTab
              onChange={onChangeContent}
              theme="none"
              value={editorState.content}
            />
          </div>
        </div>
        {editorState.errorMessage ? (
          <p className="remote-editor-error">{editorState.errorMessage}</p>
        ) : null}
        <div className="remote-editor-actions">
          <button
            className="remote-editor-button"
            disabled={editorState.isSaving || !isDirty}
            onClick={onReset}
            type="button"
          >
            Revert
          </button>
          <div className="remote-editor-actions-spacer" />
          <button
            className="remote-editor-button"
            disabled={editorState.isSaving}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
          <button
            className="remote-editor-button is-primary"
            disabled={editorState.isSaving || !isDirty}
            type="submit"
          >
            {editorState.isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function SettingsDialog({
  availableTerminalFontOptions,
  defaultNewTabDirectory,
  isSettingsTransferInProgress,
  onClose,
  onDefaultNewTabDirectoryChange,
  onExportSettings,
  onImportSettings,
  onQuickCommandsChange,
  onSftpBrowserOpenModeChange,
  onStartupModeChange,
  onTerminalColorSchemeChange,
  onTerminalCursorBlinkChange,
  onTerminalCursorColorChange,
  onTerminalSelectionColorChange,
  onTerminalCursorStyleChange,
  onTerminalCursorWidthChange,
  onTerminalFontFamilyChange,
  onTerminalFontSizeChange,
  onTerminalFontWeightChange,
  onTerminalLineHeightChange,
  quickCommands,
  settingsTransferAction,
  settingsTransferMessage,
  settingsTransferTone,
  selectedSftpBrowserOpenMode,
  selectedStartupMode,
  selectedTerminalColorSchemeId,
  selectedTerminalCursorBlink,
  selectedTerminalCursorColor,
  selectedTerminalSelectionColor,
  selectedTerminalCursorStyle,
  selectedTerminalCursorWidth,
  selectedTerminalFontFamilyId,
  selectedTerminalFontSize,
  selectedTerminalFontWeight,
  selectedTerminalLineHeight
}: SettingsDialogProps): React.JSX.Element {
  const titleId = useId()
  const [activeTabId, setActiveTabId] = useState<SettingsTabId>('general')
  const generalTabId = `${titleId}-tab-general`
  const appearanceTabId = `${titleId}-tab-appearance`
  const quickCommandsTabId = `${titleId}-tab-quick-commands`
  const panelId = `${titleId}-panel`
  const settingsTabs: Array<{
    icon: LucideIcon
    id: SettingsTabId
    label: string
    tabId: string
  }> = [
    {
      icon: Settings2,
      id: 'general',
      label: 'General',
      tabId: generalTabId
    },
    {
      icon: Palette,
      id: 'appearance',
      label: 'Appearance',
      tabId: appearanceTabId
    },
    {
      icon: FileTerminal,
      id: 'quickCommands',
      label: 'Quick Commands',
      tabId: quickCommandsTabId
    }
  ]
  const activeSettingsTabId =
    settingsTabs.find((settingsTab) => settingsTab.id === activeTabId)?.tabId ?? generalTabId

  return (
    <Modal
      appElement={document.getElementById('root') ?? undefined}
      aria={{
        labelledby: titleId
      }}
      bodyOpenClassName="ssh-config-modal-open"
      className="settings-dialog"
      contentLabel="Settings"
      isOpen
      onRequestClose={onClose}
      overlayClassName="settings-dialog-shell"
      shouldCloseOnEsc
      shouldCloseOnOverlayClick
    >
      <div className="settings-dialog-header">
        <h2 className="settings-dialog-title" id={titleId}>
          Settings
        </h2>
        <button
          aria-label="Close settings"
          className="settings-dialog-dismiss"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" className="settings-dialog-dismiss-icon" />
        </button>
      </div>
      <div aria-label="Settings sections" className="settings-dialog-tabs" role="tablist">
        {settingsTabs.map(({ icon: Icon, id, label, tabId }) => (
          <button
            aria-controls={panelId}
            aria-selected={activeTabId === id}
            className={`settings-dialog-tab${activeTabId === id ? ' is-active' : ''}`}
            id={tabId}
            key={id}
            onClick={() => setActiveTabId(id)}
            role="tab"
            type="button"
          >
            <Icon aria-hidden="true" className="settings-dialog-tab-icon" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <section
        aria-labelledby={activeSettingsTabId}
        className="settings-panel is-active"
        id={panelId}
        role="tabpanel"
      >
        {activeTabId === 'general' ? (
          <GeneralSettingsPanel
            defaultNewTabDirectory={defaultNewTabDirectory}
            isSettingsTransferInProgress={isSettingsTransferInProgress}
            onDefaultNewTabDirectoryChange={onDefaultNewTabDirectoryChange}
            onExportSettings={onExportSettings}
            onImportSettings={onImportSettings}
            onSftpBrowserOpenModeChange={onSftpBrowserOpenModeChange}
            onStartupModeChange={onStartupModeChange}
            onTerminalCursorBlinkChange={onTerminalCursorBlinkChange}
            onTerminalCursorStyleChange={onTerminalCursorStyleChange}
            onTerminalCursorWidthChange={onTerminalCursorWidthChange}
            onTerminalLineHeightChange={onTerminalLineHeightChange}
            settingsTransferAction={settingsTransferAction}
            settingsTransferMessage={settingsTransferMessage}
            settingsTransferTone={settingsTransferTone}
            selectedSftpBrowserOpenMode={selectedSftpBrowserOpenMode}
            selectedStartupMode={selectedStartupMode}
            selectedTerminalCursorBlink={selectedTerminalCursorBlink}
            selectedTerminalCursorStyle={selectedTerminalCursorStyle}
            selectedTerminalCursorWidth={selectedTerminalCursorWidth}
            selectedTerminalLineHeight={selectedTerminalLineHeight}
          />
        ) : activeTabId === 'appearance' ? (
          <AppearanceSettingsPanel
            availableTerminalFontOptions={availableTerminalFontOptions}
            onTerminalColorSchemeChange={onTerminalColorSchemeChange}
            onTerminalCursorColorChange={onTerminalCursorColorChange}
            onTerminalSelectionColorChange={onTerminalSelectionColorChange}
            onTerminalFontFamilyChange={onTerminalFontFamilyChange}
            onTerminalFontSizeChange={onTerminalFontSizeChange}
            onTerminalFontWeightChange={onTerminalFontWeightChange}
            selectedTerminalColorSchemeId={selectedTerminalColorSchemeId}
            selectedTerminalCursorColor={selectedTerminalCursorColor}
            selectedTerminalSelectionColor={selectedTerminalSelectionColor}
            selectedTerminalCursorStyle={selectedTerminalCursorStyle}
            selectedTerminalCursorWidth={selectedTerminalCursorWidth}
            selectedTerminalFontFamilyId={selectedTerminalFontFamilyId}
            selectedTerminalFontSize={selectedTerminalFontSize}
            selectedTerminalFontWeight={selectedTerminalFontWeight}
            selectedTerminalLineHeight={selectedTerminalLineHeight}
          />
        ) : (
          <QuickCommandsSettingsPanel
            onQuickCommandsChange={onQuickCommandsChange}
            quickCommands={quickCommands}
          />
        )}
      </section>
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
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null)
  const [terminalContextMenu, setTerminalContextMenu] = useState<TerminalContextMenuState | null>(
    null
  )
  const [sshBrowserContextMenu, setSshBrowserContextMenu] =
    useState<SshBrowserContextMenuState | null>(null)
  const [sshBrowserCreateDialogState, setSshBrowserCreateDialogState] =
    useState<SshBrowserCreateDialogState | null>(null)
  const [sshDownloadProgress, setSshDownloadProgress] = useState<SshDownloadProgressEvent | null>(
    null
  )
  const [sshUploadProgress, setSshUploadProgress] = useState<SshUploadProgressEvent | null>(null)
  const [sshRemoteEditorLoadingState, setSshRemoteEditorLoadingState] =
    useState<SshRemoteEditorLoadingState | null>(null)
  const [sshRemoteEditorState, setSshRemoteEditorState] = useState<SshRemoteEditorState | null>(
    null
  )
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false)
  const [quickOpenQuery, setQuickOpenQuery] = useState('')
  const [quickOpenSelectedIndex, setQuickOpenSelectedIndex] = useState(0)
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false)
  const [defaultNewTabDirectory, setDefaultNewTabDirectory] = useState('')
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([])
  const [selectedStartupMode, setSelectedStartupMode] =
    useState<AppStartupMode>(defaultAppStartupMode)
  const [selectedSftpBrowserOpenMode, setSelectedSftpBrowserOpenMode] =
    useState<SftpBrowserOpenMode>(defaultSftpBrowserOpenMode)
  const [selectedTerminalColorSchemeId, setSelectedTerminalColorSchemeId] =
    useState<TerminalColorSchemeId>(defaultTerminalColorScheme.id)
  const [selectedTerminalCursorBlink, setSelectedTerminalCursorBlink] = useState(
    defaultTerminalCursorBlink
  )
  const [selectedTerminalCursorColor, setSelectedTerminalCursorColor] = useState<string | null>(
    null
  )
  const [selectedTerminalSelectionColor, setSelectedTerminalSelectionColor] = useState<
    string | null
  >(null)
  const [selectedTerminalCursorStyle, setSelectedTerminalCursorStyle] =
    useState<TerminalCursorStyle>(defaultTerminalCursorStyle)
  const [selectedTerminalCursorWidth, setSelectedTerminalCursorWidth] = useState(
    defaultTerminalCursorWidth
  )
  const [selectedTerminalFontFamilyId, setSelectedTerminalFontFamilyId] =
    useState<TerminalFontFamilyId>(defaultTerminalFontFamilyId)
  const [selectedTerminalFontSize, setSelectedTerminalFontSize] =
    useState<number>(defaultTerminalFontSize)
  const [selectedTerminalFontWeight, setSelectedTerminalFontWeight] =
    useState<TerminalFontWeight>(defaultTerminalFontWeight)
  const [selectedTerminalLineHeight, setSelectedTerminalLineHeight] =
    useState(defaultTerminalLineHeight)
  const [hasHydratedSettings, setHasHydratedSettings] = useState(false)
  const [settingsTransferAction, setSettingsTransferAction] =
    useState<SettingsTransferAction | null>(null)
  const [settingsTransferMessage, setSettingsTransferMessage] = useState<string | null>(null)
  const [settingsTransferTone, setSettingsTransferTone] = useState<SettingsTransferTone>('success')
  const [isSshConfigDialogOpen, setIsSshConfigDialogOpen] = useState(false)
  const [sshServerBeingEdited, setSshServerBeingEdited] = useState<SshServerConfig | null>(null)
  const [sshServers, setSshServers] = useState<SshServerConfig[]>([])
  const nextTabIdRef = useRef(1)
  const nextPaneIdRef = useRef(1)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const workspaceShellRef = useRef<HTMLElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const sshMenuRef = useRef<HTMLDivElement>(null)
  const tabContextMenuRef = useRef<HTMLDivElement>(null)
  const terminalContextMenuRef = useRef<HTMLDivElement>(null)
  const sshBrowserContextMenuRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<TabRecord[]>([])
  const sshBrowserStatesRef = useRef<SshBrowserStates>({})
  const sshBrowserListElementsRef = useRef(new Map<string, HTMLDivElement>())
  const previousSshBrowserFiltersRef = useRef(new Map<string, string>())
  const activeTabIdRef = useRef<string | null>(null)
  const isSearchOpenRef = useRef(false)
  const hostElementsRef = useRef(new Map<string, HTMLDivElement>())
  const paneToTabRef = useRef(new Map<string, string>())
  const runtimesRef = useRef(new Map<string, TerminalRuntime>())
  const searchMatchesRef = useRef<SearchMatch[]>([])
  const searchRefreshTimeoutRef = useRef<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const quickOpenInputRef = useRef<HTMLInputElement>(null)
  const quickOpenResultsRef = useRef<HTMLDivElement>(null)
  const searchResultIndexRef = useRef(-1)
  const searchQueryRef = useRef('')
  const sshBrowserResizePointerIdRef = useRef<number | null>(null)
  const sshBrowserResizeTabIdRef = useRef<string | null>(null)
  const sshBrowserRequestIdRef = useRef(0)
  const sshDownloadHideTimeoutRef = useRef<number | null>(null)
  const sshUploadHideTimeoutRef = useRef<number | null>(null)
  const sshCwdSequenceBuffersRef = useRef(new Map<number, string>())
  const terminalToPaneRef = useRef(new Map<number, string>())
  const pendingTerminalStateRef = useRef(new Map<number, PendingTerminalState>())
  const pendingInitialPaneStateRef = useRef(new Map<string, CreateTabOptions>())
  const initialSessionSnapshotRef = useRef<SessionSnapshot | null | undefined>(undefined)
  const hasInitializedSessionRestoreRef = useRef(false)
  const isUnmountingRef = useRef(false)
  const emptyStateCreateQueuedRef = useRef(false)
  const pendingActivationTabIdRef = useRef<string | null>(null)
  const platformClassName =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
      ? 'platform-macos'
      : 'platform-default'
  const selectedTerminalColorScheme =
    terminalColorSchemesById.get(selectedTerminalColorSchemeId) ?? defaultTerminalColorScheme
  const selectedTerminalTheme = getConfiguredTerminalTheme(
    selectedTerminalColorScheme.theme,
    selectedTerminalCursorColor,
    selectedTerminalSelectionColor
  )
  const availableTerminalFontOptions = bundledTerminalFontOptions
  const selectedTerminalFontOption =
    availableTerminalFontOptions.find(
      (fontOption) => fontOption.id === selectedTerminalFontFamilyId
    ) ?? defaultTerminalFontOption
  const isSettingsTransferInProgress = settingsTransferAction !== null

  const applyAppSettings = useCallback((settings: AppSettings): void => {
    const normalizedSettings = getNormalizedAppSettings(settings)

    setDefaultNewTabDirectory(normalizedSettings.defaultNewTabDirectory)
    setQuickCommands(normalizedSettings.quickCommands)
    setSelectedSftpBrowserOpenMode(normalizedSettings.sftpBrowserOpenMode)
    setSelectedStartupMode(normalizedSettings.startupMode)
    setSelectedTerminalColorSchemeId(normalizedSettings.terminalColorSchemeId)
    setSelectedTerminalCursorBlink(normalizedSettings.terminalCursorBlink)
    setSelectedTerminalCursorColor(normalizedSettings.terminalCursorColor)
    setSelectedTerminalSelectionColor(normalizedSettings.terminalSelectionColor)
    setSelectedTerminalCursorStyle(normalizedSettings.terminalCursorStyle)
    setSelectedTerminalCursorWidth(normalizedSettings.terminalCursorWidth)
    setSelectedTerminalFontFamilyId(normalizedSettings.terminalFontFamilyId)
    setSelectedTerminalFontSize(normalizedSettings.terminalFontSize)
    setSelectedTerminalFontWeight(normalizedSettings.terminalFontWeight)
    setSelectedTerminalLineHeight(normalizedSettings.terminalLineHeight)
  }, [])

  useEffect(() => {
    let isCancelled = false

    void (async () => {
      try {
        const savedSettings = await window.api.settings.load()

        if (isCancelled) {
          return
        }

        if (savedSettings) {
          applyAppSettings(savedSettings)
        }
      } catch (error) {
        console.error('Unable to load the saved app settings.', error)
      } finally {
        if (!isCancelled) {
          setHasHydratedSettings(true)
        }
      }
    })()

    return () => {
      isCancelled = true
    }
  }, [applyAppSettings])

  const handleImportSettings = useCallback(async (): Promise<void> => {
    setSettingsTransferAction('import')
    setSettingsTransferMessage(null)

    try {
      const result = await window.api.settings.importFromFile()

      if (!result) {
        return
      }

      applyAppSettings(result.settings)
      void window.api.ssh
        .listConfigs()
        .then((configs) => {
          setSshServers(configs)
        })
        .catch((error) => {
          console.error('Unable to reload SSH servers after importing settings.', error)
        })
      setSettingsTransferTone('success')
      setSettingsTransferMessage(`Imported settings from ${result.filePath}.`)
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : 'Unable to import settings.'

      setSettingsTransferTone('error')
      setSettingsTransferMessage(message)
    } finally {
      setSettingsTransferAction(null)
    }
  }, [applyAppSettings])

  const handleExportSettings = useCallback(async (): Promise<void> => {
    setSettingsTransferAction('export')
    setSettingsTransferMessage(null)

    try {
      const result = await window.api.settings.exportToFile()

      if (!result) {
        return
      }

      setSettingsTransferTone('success')
      setSettingsTransferMessage(`Exported settings to ${result.filePath}.`)
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : 'Unable to export settings.'

      setSettingsTransferTone('error')
      setSettingsTransferMessage(message)
    } finally {
      setSettingsTransferAction(null)
    }
  }, [])

  const updateTab = useCallback((tabId: string, updater: (tab: TabRecord) => TabRecord): void => {
    setTabs((currentTabs) =>
      currentTabs.map((tab) => {
        if (tab.id !== tabId) {
          return tab
        }

        const nextTab = updater(tab)

        if (nextTab === tab) {
          return tab
        }

        return syncTabWithActivePane(nextTab)
      })
    )
  }, [])

  const updatePane = useCallback(
    (
      tabId: string,
      paneId: string,
      updater: (pane: TabPaneRecord, tab: TabRecord) => TabPaneRecord
    ): void => {
      updateTab(tabId, (tab) => {
        let didChange = false
        const nextPanes = tab.panes.map((pane) => {
          if (pane.id !== paneId) {
            return pane
          }

          const nextPane = updater(pane, tab)

          if (nextPane !== pane) {
            didChange = true
          }

          return nextPane
        })

        return didChange
          ? {
              ...tab,
              panes: nextPanes
            }
          : tab
      })
    },
    [updateTab]
  )

  const getActivePaneIdForTab = useCallback((tabId: string | null): string | null => {
    if (!tabId) {
      return null
    }

    const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
    return tab ? (getActivePane(tab)?.id ?? null) : null
  }, [])

  const getPaneRuntime = useCallback((paneId: string | null): TerminalRuntime | null => {
    if (!paneId) {
      return null
    }

    return runtimesRef.current.get(paneId) ?? null
  }, [])

  const getTabOutputLinesForSnapshot = useCallback((tab: TabRecord): string[] | undefined => {
    const activePane = getActivePane(tab)
    const runtime = activePane ? runtimesRef.current.get(activePane.id) : undefined

    if (runtime && !runtime.disposed) {
      return getPersistedTerminalOutputLines(runtime.terminal)
    }

    return clonePersistedOutputLines(activePane?.outputLines)
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

  const closeSshBrowserCreateDialog = useCallback((): void => {
    setSshBrowserCreateDialogState(null)
  }, [])

  const closeTabContextMenu = useCallback((): void => {
    setTabContextMenu(null)
  }, [])

  const closeTerminalContextMenu = useCallback((): void => {
    setTerminalContextMenu(null)
  }, [])

  const closeSshRemoteEditor = useCallback((): boolean => {
    if (!sshRemoteEditorState) {
      return true
    }

    if (sshRemoteEditorState.content !== sshRemoteEditorState.initialContent) {
      const shouldDiscard = window.confirm(
        `Discard unsaved changes to "${getRemotePathBaseName(sshRemoteEditorState.path)}"?`
      )

      if (!shouldDiscard) {
        return false
      }
    }

    setSshRemoteEditorState(null)
    return true
  }, [sshRemoteEditorState])

  const handleChangeSshRemoteEditorContent = useCallback((content: string): void => {
    setSshRemoteEditorState((currentState) => {
      if (!currentState) {
        return currentState
      }

      return {
        ...currentState,
        content,
        errorMessage: null
      }
    })
  }, [])

  const handleResetSshRemoteEditor = useCallback((): void => {
    setSshRemoteEditorState((currentState) => {
      if (!currentState) {
        return currentState
      }

      return {
        ...currentState,
        content: currentState.initialContent,
        errorMessage: null
      }
    })
  }, [])

  const handleSaveSshRemoteEditor = useCallback((): void => {
    const currentState = sshRemoteEditorState

    if (
      !currentState ||
      currentState.isSaving ||
      currentState.content === currentState.initialContent
    ) {
      return
    }

    const nextContent = normalizeSshRemoteEditorContent(
      currentState.content,
      currentState.lineEnding
    )
    const nextSize = new TextEncoder().encode(nextContent).length

    setSshRemoteEditorState((previousState) =>
      previousState && previousState.path === currentState.path
        ? {
            ...previousState,
            errorMessage: null,
            isSaving: true
          }
        : previousState
    )

    const saveRequest =
      currentState.kind === 'ssh'
        ? window.api.ssh.writeTextFile(currentState.configId, currentState.path, nextContent)
        : window.api.shell.writeTextFile(currentState.path, nextContent)

    void saveRequest
      .then(() => {
        setSshRemoteEditorState((previousState) =>
          previousState && previousState.path === currentState.path
            ? {
                ...previousState,
                content: nextContent,
                errorMessage: null,
                initialContent: nextContent,
                isSaving: false,
                size: nextSize
              }
            : previousState
        )
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)

        setSshRemoteEditorState((previousState) =>
          previousState && previousState.path === currentState.path
            ? {
                ...previousState,
                errorMessage:
                  message ||
                  (currentState.kind === 'ssh'
                    ? 'Unable to save this remote file.'
                    : 'Unable to save this local file.'),
                isSaving: false
              }
            : previousState
        )
      })
  }, [sshRemoteEditorState])

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
        const requestedPath =
          path ?? (currentState && currentState.configId === configId ? currentState.path : null)
        const shouldResetEntries =
          currentState !== undefined &&
          currentState.configId === configId &&
          requestedPath !== null &&
          currentState.path !== requestedPath

        return {
          ...currentStates,
          [tabId]: {
            configId,
            entries:
              currentState && currentState.configId === configId && !shouldResetEntries
                ? currentState.entries
                : [],
            errorMessage: null,
            filterQuery:
              currentState && currentState.configId === configId ? currentState.filterQuery : '',
            isLoading: true,
            pendingPath: requestedPath,
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
                pendingPath: null,
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
                isLoading: false,
                pendingPath: null
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

  const getTerminalThemeForSearchState = useCallback(
    (searchIsOpen: boolean): ITheme => {
      return searchIsOpen ? getSearchTerminalTheme(selectedTerminalTheme) : selectedTerminalTheme
    },
    [selectedTerminalTheme]
  )

  const focusActiveTerminal = useCallback((): void => {
    const currentActiveTabId = activeTabIdRef.current

    if (!currentActiveTabId) {
      return
    }

    const runtime = getPaneRuntime(getActivePaneIdForTab(currentActiveTabId))

    if (!runtime || runtime.disposed) {
      return
    }

    runtime.terminal.focus()
  }, [getActivePaneIdForTab, getPaneRuntime])

  const writeActiveTerminalShortcut = useCallback(
    (data: string): boolean => {
      const currentActiveTabId = activeTabIdRef.current
      const runtime = getPaneRuntime(getActivePaneIdForTab(currentActiveTabId))

      if (!runtime || runtime.disposed || runtime.closed || runtime.terminalId === null) {
        return false
      }

      window.api.terminal.write(runtime.terminalId, data)
      return true
    },
    [getActivePaneIdForTab, getPaneRuntime]
  )

  const refreshSearchMatches = useCallback(
    (tabId: string | null, query: string): boolean => {
      if (!tabId || query === '') {
        clearSearchSelection()
        resetSearchResults()
        return false
      }

      const runtime = getPaneRuntime(getActivePaneIdForTab(tabId))

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
    [clearSearchSelection, getActivePaneIdForTab, getPaneRuntime, resetSearchResults]
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
    setIsSearchOpen(true)
  }, [])

  const closeSearch = useCallback((): void => {
    cancelQueuedSearchRefresh()
    clearSearchSelection()
    resetSearchResults()
    setSearchQuery('')
    setIsSearchOpen(false)
    focusActiveTerminal()
  }, [cancelQueuedSearchRefresh, clearSearchSelection, focusActiveTerminal, resetSearchResults])

  const restorePrimaryFocus = useCallback((): void => {
    if (isSearchOpenRef.current) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }

    focusActiveTerminal()
  }, [focusActiveTerminal])

  const openQuickOpen = useCallback((): void => {
    setIsSshMenuOpen(false)
    closeTabContextMenu()
    closeTerminalContextMenu()
    closeSshBrowserContextMenu()

    if (isQuickOpenOpen) {
      window.requestAnimationFrame(() => {
        quickOpenInputRef.current?.focus()
        quickOpenInputRef.current?.select()
      })
      return
    }

    setQuickOpenQuery('')
    setQuickOpenSelectedIndex(0)
    setIsQuickOpenOpen(true)
  }, [
    closeSshBrowserContextMenu,
    closeTabContextMenu,
    closeTerminalContextMenu,
    isQuickOpenOpen,
    quickOpenInputRef
  ])

  const closeQuickOpen = useCallback(
    (shouldRestoreFocus = true): void => {
      setQuickOpenQuery('')
      setQuickOpenSelectedIndex(0)
      setIsQuickOpenOpen(false)

      if (!shouldRestoreFocus) {
        return
      }

      window.requestAnimationFrame(() => {
        restorePrimaryFocus()
      })
    },
    [restorePrimaryFocus]
  )

  const clearTerminalContent = useCallback(
    (paneId: string): void => {
      const runtime = getPaneRuntime(paneId)

      if (!runtime || runtime.disposed) {
        return
      }

      runtime.terminal.focus()
      runtime.terminal.clear()

      if (
        activeTabIdRef.current !== null &&
        getActivePaneIdForTab(activeTabIdRef.current) === paneId &&
        isSearchOpenRef.current
      ) {
        queueSearchRefresh(activeTabIdRef.current, 0)
      }
    },
    [getActivePaneIdForTab, getPaneRuntime, queueSearchRefresh]
  )

  const clearActiveTerminalContent = useCallback((): void => {
    const currentActiveTabId = activeTabIdRef.current

    if (!currentActiveTabId) {
      return
    }

    const paneId = getActivePaneIdForTab(currentActiveTabId)

    if (!paneId) {
      return
    }

    clearTerminalContent(paneId)
  }, [clearTerminalContent, getActivePaneIdForTab])

  const findNextMatch = useCallback((): void => {
    const activeTabId = activeTabIdRef.current

    if (!activeTabId || searchQueryRef.current === '') {
      return
    }

    const runtime = getPaneRuntime(getActivePaneIdForTab(activeTabId))

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
  }, [getActivePaneIdForTab, getPaneRuntime, resetSearchResults])

  const findPreviousMatch = useCallback((): void => {
    const activeTabId = activeTabIdRef.current

    if (!activeTabId || searchQueryRef.current === '') {
      return
    }

    const runtime = getPaneRuntime(getActivePaneIdForTab(activeTabId))

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
  }, [getActivePaneIdForTab, getPaneRuntime, resetSearchResults])

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

      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const activePaneId = tab ? (getActivePane(tab)?.id ?? null) : null

      if (!tab || !activePaneId) {
        return
      }

      for (const pane of tab.panes) {
        const runtime = runtimesRef.current.get(pane.id)
        const hostElement = hostElementsRef.current.get(pane.id)

        if (!runtime || runtime.disposed || !hostElement) {
          continue
        }

        runtime.fitAddon.fit()

        if (runtime.terminalId !== null && !runtime.closed) {
          window.api.terminal.resize(
            runtime.terminalId,
            runtime.terminal.cols,
            runtime.terminal.rows
          )
        }

        if (shouldFocus && pane.id === activePaneId) {
          runtime.terminal.focus()
        }
      }
    })
  }, [])

  const applyTerminalTypography = useCallback(
    (
      fontFamily: string,
      fontSize: number,
      fontWeight: TerminalFontWeight,
      lineHeight: number
    ): void => {
      const refreshTerminalTypography = (): void => {
        for (const runtime of runtimesRef.current.values()) {
          if (runtime.disposed) {
            continue
          }

          runtime.terminal.options.fontFamily = fontFamily
          runtime.terminal.options.fontSize = fontSize
          runtime.terminal.options.fontWeight = fontWeight
          runtime.terminal.options.lineHeight = lineHeight
          runtime.terminal.clearTextureAtlas()
          runtime.terminal.refresh(0, runtime.terminal.rows - 1)
        }

        syncActiveTabLayout(activeTabIdRef.current)
      }

      refreshTerminalTypography()

      if (typeof document !== 'undefined' && typeof document.fonts?.load === 'function') {
        void document.fonts
          .load(`${fontWeight} ${fontSize}px ${fontFamily}`, 'BESbqw09@$')
          .then(() => {
            refreshTerminalTypography()
          })
          .catch((error) => {
            console.error(`Unable to finish loading terminal font "${fontFamily}".`, error)
          })
      }
    },
    [syncActiveTabLayout]
  )

  const applyTerminalCursorSettings = useCallback(
    (cursorBlink: boolean, cursorStyle: TerminalCursorStyle, cursorWidth: number): void => {
      for (const runtime of runtimesRef.current.values()) {
        if (runtime.disposed) {
          continue
        }

        runtime.terminal.options.cursorBlink = cursorBlink
        runtime.terminal.options.cursorStyle = cursorStyle
        runtime.terminal.options.cursorWidth = cursorWidth
        runtime.terminal.refresh(0, runtime.terminal.rows - 1)
      }
    },
    []
  )

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

  const clearPaneReconnectTimeout = useCallback((paneId: string): void => {
    const runtime = runtimesRef.current.get(paneId)

    if (!runtime || runtime.reconnectTimeoutId === null) {
      return
    }

    window.clearTimeout(runtime.reconnectTimeoutId)
    runtime.reconnectTimeoutId = null
  }, [])

  const finalizePaneConnection = useCallback(
    (
      tabId: string,
      paneId: string,
      terminalId: number,
      title: string,
      preferredTitle?: string,
      shouldActivatePendingTab = false
    ): void => {
      const currentRuntime = runtimesRef.current.get(paneId)

      if (!currentRuntime || currentRuntime.disposed || isUnmountingRef.current) {
        window.api.terminal.kill(terminalId)
        return
      }

      currentRuntime.closed = false
      clearPaneReconnectTimeout(paneId)
      currentRuntime.terminalId = terminalId
      currentRuntime.terminal.options.disableStdin = false
      terminalToPaneRef.current.set(terminalId, paneId)
      const pendingTerminalState = pendingTerminalStateRef.current.get(terminalId)
      pendingTerminalStateRef.current.delete(terminalId)

      updatePane(tabId, paneId, (pane) => {
        const nextRestoreState =
          pendingTerminalState && pane.restoreState.kind === 'local'
            ? {
                cwd: pendingTerminalState.cwd,
                kind: 'local' as const
              }
            : pane.restoreState

        return {
          ...pane,
          errorMessage: undefined,
          exitCode: undefined,
          reconnectAttempt: undefined,
          restoreState: nextRestoreState,
          status: 'ready',
          terminalId,
          title: preferredTitle ?? pendingTerminalState?.title ?? title
        }
      })

      if (shouldActivatePendingTab && pendingActivationTabIdRef.current === tabId) {
        pendingActivationTabIdRef.current = null
        setActiveTabId(tabId)
      }

      if (activeTabIdRef.current === tabId) {
        syncActiveTabLayout(tabId, getActivePaneIdForTab(tabId) === paneId)
      }
    },
    [clearPaneReconnectTimeout, getActivePaneIdForTab, syncActiveTabLayout, updatePane]
  )

  const failPaneConnection = useCallback(
    (
      tabId: string,
      paneId: string,
      message: string,
      terminalMessage: string,
      shouldActivatePendingTab = false
    ): void => {
      const currentRuntime = runtimesRef.current.get(paneId)

      pendingInitialPaneStateRef.current.delete(paneId)

      if (!currentRuntime || currentRuntime.disposed) {
        return
      }

      clearPaneReconnectTimeout(paneId)
      currentRuntime.closed = true
      currentRuntime.terminalId = null
      currentRuntime.terminal.options.disableStdin = true
      currentRuntime.terminal.write(`${terminalMessage}: ${message}\r\n`)

      updatePane(tabId, paneId, (pane) => ({
        ...pane,
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
    [clearPaneReconnectTimeout, updatePane]
  )

  const reconnectSshPane = useCallback(
    (tabId: string, paneId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const pane = tab ? getPaneById(tab, paneId) : null
      const runtime = runtimesRef.current.get(paneId)

      if (!pane || pane.restoreState.kind !== 'ssh' || pane.status === 'connecting') {
        return
      }

      if (!runtime || runtime.disposed || isUnmountingRef.current) {
        return
      }

      clearPaneReconnectTimeout(paneId)

      updatePane(tabId, paneId, (currentPane) => {
        if (currentPane.restoreState.kind !== 'ssh' || currentPane.status === 'connecting') {
          return currentPane
        }

        return {
          ...currentPane,
          errorMessage: undefined,
          exitCode: undefined,
          reconnectAttempt:
            typeof currentPane.reconnectAttempt === 'number' ? currentPane.reconnectAttempt : 1,
          status: 'connecting',
          terminalId: null
        }
      })

      runtime.closed = true
      runtime.terminalId = null
      runtime.terminal.options.disableStdin = true
      runtime.terminal.write('\r\n[reconnecting...]\r\n')

      void window.api.ssh
        .connect(pane.restoreState.configId, pane.restoreState.cwd)
        .then(({ terminalId, title }) => {
          finalizePaneConnection(tabId, paneId, terminalId, title)
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          failPaneConnection(tabId, paneId, message, 'Unable to reconnect')
        })
    },
    [clearPaneReconnectTimeout, failPaneConnection, finalizePaneConnection, updatePane]
  )

  const scheduleSshPaneReconnect = useCallback(
    (tabId: string, paneId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const pane = tab ? getPaneById(tab, paneId) : null
      const runtime = runtimesRef.current.get(paneId)

      if (
        !pane ||
        pane.restoreState.kind !== 'ssh' ||
        !runtime ||
        runtime.disposed ||
        isUnmountingRef.current ||
        runtime.reconnectTimeoutId !== null
      ) {
        return
      }

      runtime.closed = true
      runtime.terminalId = null
      runtime.terminal.options.disableStdin = true
      runtime.terminal.write(`\r\n[reconnecting in ${sshReconnectDelayMs / 1000}s...]\r\n`)

      updatePane(tabId, paneId, (currentPane) => {
        if (currentPane.restoreState.kind !== 'ssh') {
          return currentPane
        }

        return {
          ...currentPane,
          errorMessage: undefined,
          exitCode: undefined,
          reconnectAttempt:
            typeof currentPane.reconnectAttempt === 'number' ? currentPane.reconnectAttempt + 1 : 1,
          status: 'closed',
          terminalId: null
        }
      })

      runtime.reconnectTimeoutId = window.setTimeout(() => {
        const currentRuntime = runtimesRef.current.get(paneId)

        if (!currentRuntime || currentRuntime.disposed) {
          return
        }

        currentRuntime.reconnectTimeoutId = null
        reconnectSshPane(tabId, paneId)
      }, sshReconnectDelayMs)
    },
    [reconnectSshPane, updatePane]
  )

  const maybeReconnectSshPane = useCallback(
    (tabId: string, paneId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const pane = tab ? getPaneById(tab, paneId) : null
      const runtime = runtimesRef.current.get(paneId)

      if (
        !pane ||
        pane.restoreState.kind !== 'ssh' ||
        pane.status !== 'closed' ||
        pane.terminalId !== null ||
        !runtime ||
        runtime.disposed ||
        runtime.reconnectTimeoutId !== null ||
        runtime.terminalId !== null
      ) {
        return
      }

      reconnectSshPane(tabId, paneId)
    },
    [reconnectSshPane]
  )

  const activateTab = useCallback(
    (tabId: string): void => {
      setActiveTabId(tabId)

      if (activeTabIdRef.current === tabId) {
        const paneId = getActivePaneIdForTab(tabId)

        if (paneId) {
          maybeReconnectSshPane(tabId, paneId)
        }
      }
    },
    [getActivePaneIdForTab, maybeReconnectSshPane]
  )

  const activatePane = useCallback(
    (tabId: string, paneId: string, shouldFocus = true): void => {
      setActiveTabId(tabId)
      updateTab(tabId, (tab) =>
        tab.activePaneId === paneId
          ? tab
          : {
              ...tab,
              activePaneId: paneId
            }
      )
      maybeReconnectSshPane(tabId, paneId)

      if (!shouldFocus) {
        return
      }

      window.requestAnimationFrame(() => {
        if (activeTabIdRef.current !== tabId) {
          return
        }

        const runtime = runtimesRef.current.get(paneId)

        if (!runtime || runtime.disposed) {
          return
        }

        runtime.terminal.focus()
      })
    },
    [maybeReconnectSshPane, updateTab]
  )

  const disposePaneRuntime = useCallback((paneId: string, shouldKill: boolean): void => {
    const runtime = runtimesRef.current.get(paneId)

    if (!runtime) {
      return
    }

    clearPaneReconnectTimeout(paneId)
    runtime.disposed = true
    runtime.disposeFocus.dispose()
    runtime.disposeInput.dispose()

    if (runtime.terminalId !== null) {
      terminalToPaneRef.current.delete(runtime.terminalId)
      pendingTerminalStateRef.current.delete(runtime.terminalId)
      sshCwdSequenceBuffersRef.current.delete(runtime.terminalId)

      if (shouldKill && !runtime.closed) {
        window.api.terminal.kill(runtime.terminalId)
      }
    }

    runtime.terminal.dispose()
    runtimesRef.current.delete(paneId)
  }, [clearPaneReconnectTimeout])

  const createTab = useCallback(
    (options?: CreateTabOptions): void => {
      const tabId = `tab-${nextTabIdRef.current++}`
      const shouldActivateImmediately =
        activeTabIdRef.current === null || tabsRef.current.length === 0
      const defaultLocalTabCreateOptions =
        options === undefined ? getDefaultLocalTabCreateOptions(defaultNewTabDirectory) : null
      const createTerminal = options?.createTerminal
      const trimmedTitle = options?.title?.trim()
      const nextTitle = trimmedTitle || defaultTabTitle
      const restoreState = cloneRestorableTabState(
        options?.restoreState ??
          defaultLocalTabCreateOptions?.restoreState ??
          getDefaultRestorableTabState()
      )
      const terminalCreateOptions =
        options?.terminalCreateOptions ?? defaultLocalTabCreateOptions?.terminalCreateOptions
      const primaryPane = createPaneRecord(tabId, {
        restoreState,
        title: nextTitle
      })

      if (createTerminal || terminalCreateOptions || trimmedTitle) {
        pendingInitialPaneStateRef.current.set(tabId, {
          createTerminal,
          restoreState,
          terminalCreateOptions,
          title: trimmedTitle
        })
      }

      setTabs((currentTabs) => [...currentTabs, createTabRecordFromPane(tabId, primaryPane)])

      if (shouldActivateImmediately) {
        pendingActivationTabIdRef.current = null
        setActiveTabId(tabId)
        return
      }

      pendingActivationTabIdRef.current = tabId
    },
    [defaultNewTabDirectory]
  )

  const createSplitPaneForTab = useCallback(
    (tabId: string, requestedOrientation: PaneSplitOrientation): void => {
      if (activeTabIdRef.current !== tabId) {
        setActiveTabId(tabId)
      }

      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const activePane = tab ? getActivePane(tab) : null

      if (!tab || !activePane || !canSplitTabPane(tab, requestedOrientation)) {
        return
      }

      const paneId = `pane-${nextPaneIdRef.current++}`
      const nextPaneTitle = activePane.title.trim() || defaultTabTitle
      const nextPaneRestoreState = cloneRestorableTabState(tab.restoreState)
      let paneCreateOptions: CreateTabOptions

      if (tab.restoreState.kind === 'ssh') {
        const sshRestoreState = tab.restoreState

        paneCreateOptions = {
          createTerminal: () =>
            window.api.ssh.connect(sshRestoreState.configId, sshRestoreState.cwd),
          restoreState: nextPaneRestoreState,
          title: nextPaneTitle
        }
      } else {
        paneCreateOptions = {
          restoreState: nextPaneRestoreState,
          terminalCreateOptions: tab.restoreState.cwd
            ? {
                cwd: tab.restoreState.cwd
              }
            : undefined,
          title: nextPaneTitle
        }
      }

      pendingInitialPaneStateRef.current.set(paneId, paneCreateOptions)

      setTabs((currentTabs) =>
        currentTabs.map((currentTab) => {
          if (currentTab.id !== tabId) {
            return currentTab
          }

          return syncTabWithActivePane({
            ...currentTab,
            activePaneId: paneId,
            paneOrientation:
              currentTab.paneOrientation ??
              (currentTab.panes.length === 1 ? requestedOrientation : null),
            panes: [
              ...currentTab.panes,
              createPaneRecord(paneId, {
                restoreState: tab.restoreState,
                title: nextPaneTitle
              })
            ]
          })
        })
      )
    },
    []
  )

  const closePane = useCallback(
    (tabId: string, paneId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)

      if (!tab || tab.panes.length <= 1) {
        return
      }

      pendingInitialPaneStateRef.current.delete(paneId)
      disposePaneRuntime(paneId, true)
      hostElementsRef.current.delete(paneId)
      paneToTabRef.current.delete(paneId)

      setTabs((currentTabs) =>
        currentTabs.map((currentTab) => {
          if (currentTab.id !== tabId) {
            return currentTab
          }

          const nextPanes = currentTab.panes.filter((pane) => pane.id !== paneId)
          const nextActivePaneId =
            currentTab.activePaneId === paneId
              ? (nextPanes[nextPanes.length - 1]?.id ?? nextPanes[0]?.id ?? currentTab.activePaneId)
              : currentTab.activePaneId

          return syncTabWithActivePane({
            ...currentTab,
            activePaneId: nextActivePaneId,
            paneOrientation: nextPanes.length > 1 ? currentTab.paneOrientation : null,
            panes: nextPanes
          })
        })
      )

      if (activeTabIdRef.current === tabId) {
        window.requestAnimationFrame(() => {
          syncActiveTabLayout(tabId, true)
        })
      }
    },
    [disposePaneRuntime, syncActiveTabLayout]
  )

  const closeActivePaneForTab = useCallback(
    (tabId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const activePane = tab ? getActivePane(tab) : null

      if (!tab || !activePane) {
        return
      }

      if (activeTabIdRef.current !== tabId) {
        setActiveTabId(tabId)
      }

      closePane(tabId, activePane.id)
    },
    [closePane]
  )

  const closeTab = useCallback(
    (tabId: string): void => {
      const currentTabs = tabsRef.current
      const tabIndex = currentTabs.findIndex((tab) => tab.id === tabId)
      const tab = currentTabs[tabIndex]

      if (!tab) {
        return
      }

      if (pendingActivationTabIdRef.current === tabId) {
        pendingActivationTabIdRef.current = null
      }

      closeSshBrowserForTab(tabId)
      removeSshBrowserWidthForTab(tabId)

      for (const pane of tab.panes) {
        pendingInitialPaneStateRef.current.delete(pane.id)
        disposePaneRuntime(pane.id, true)
        hostElementsRef.current.delete(pane.id)
        paneToTabRef.current.delete(pane.id)
      }

      const remainingTabs = currentTabs.filter((currentTab) => currentTab.id !== tabId)
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
    [activateTab, closeSshBrowserForTab, disposePaneRuntime, removeSshBrowserWidthForTab]
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

  const initializePane = useCallback(
    (tabId: string, pane: TabPaneRecord, hostElement: HTMLDivElement): void => {
      const paneId = pane.id

      if (runtimesRef.current.has(paneId)) {
        return
      }

      paneToTabRef.current.set(paneId, tabId)

      const terminal = new Terminal({
        ...terminalOptions,
        cursorBlink: selectedTerminalCursorBlink,
        cursorStyle: selectedTerminalCursorStyle,
        cursorWidth: selectedTerminalCursorWidth,
        fontFamily: selectedTerminalFontOption.fontFamily,
        fontSize: selectedTerminalFontSize,
        fontWeight: selectedTerminalFontWeight,
        lineHeight: selectedTerminalLineHeight,
        theme: getTerminalThemeForSearchState(isSearchOpenRef.current)
      })
      const fitAddon = new FitAddon()

      terminal.loadAddon(fitAddon)
      terminal.open(hostElement)
      restorePersistedTerminalOutput(terminal, pane.outputLines)
      const terminalTextarea = terminal.textarea
      const handleTerminalFocus = (): void => {
        window.api.terminal.setFocused(true)
      }
      const handleTerminalBlur = (): void => {
        window.api.terminal.setFocused(false)
      }

      terminalTextarea?.addEventListener('focus', handleTerminalFocus)
      terminalTextarea?.addEventListener('blur', handleTerminalBlur)

      const runtime: TerminalRuntime = {
        closed: false,
        disposed: false,
        disposeFocus: {
          dispose: () => {
            terminalTextarea?.removeEventListener('focus', handleTerminalFocus)
            terminalTextarea?.removeEventListener('blur', handleTerminalBlur)
          }
        },
        disposeInput: terminal.onData((data) => {
          const currentRuntime = runtimesRef.current.get(paneId)

          if (!currentRuntime || currentRuntime.closed || currentRuntime.terminalId === null) {
            return
          }

          window.api.terminal.write(currentRuntime.terminalId, data)
        }),
        fitAddon,
        reconnectTimeoutId: null,
        terminal,
        terminalId: null
      }

      runtimesRef.current.set(paneId, runtime)

      if (activeTabIdRef.current === tabId) {
        syncActiveTabLayout(tabId, getActivePaneIdForTab(tabId) === paneId)
      }

      if (
        activeTabIdRef.current === tabId &&
        isSearchOpenRef.current &&
        searchQueryRef.current !== '' &&
        getActivePaneIdForTab(tabId) === paneId
      ) {
        queueSearchRefresh(tabId, 0)
      }

      const pendingInitialPaneState = pendingInitialPaneStateRef.current.get(paneId)
      const createTerminalRequest = Promise.resolve().then(() =>
        pendingInitialPaneState?.createTerminal
          ? pendingInitialPaneState.createTerminal()
          : window.api.terminal.create(pendingInitialPaneState?.terminalCreateOptions)
      )

      createTerminalRequest
        .then(({ terminalId, title }) => {
          pendingInitialPaneStateRef.current.delete(paneId)
          finalizePaneConnection(
            tabId,
            paneId,
            terminalId,
            title,
            pendingInitialPaneState?.title,
            paneId === tabId
          )
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)

          failPaneConnection(tabId, paneId, message, 'Unable to start shell', paneId === tabId)
        })
    },
    [
      failPaneConnection,
      finalizePaneConnection,
      getTerminalThemeForSearchState,
      getActivePaneIdForTab,
      queueSearchRefresh,
      selectedTerminalCursorBlink,
      selectedTerminalCursorStyle,
      selectedTerminalCursorWidth,
      selectedTerminalFontOption,
      selectedTerminalFontSize,
      selectedTerminalFontWeight,
      selectedTerminalLineHeight,
      syncActiveTabLayout
    ]
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
    paneToTabRef.current.clear()

    for (const tab of tabs) {
      for (const pane of tab.panes) {
        paneToTabRef.current.set(pane.id, tab.id)
      }
    }

    if (tabs.length > 0) {
      emptyStateCreateQueuedRef.current = false
    }
  }, [tabs])

  useEffect(() => {
    sshBrowserStatesRef.current = sshBrowserStates
  }, [sshBrowserStates])

  useLayoutEffect(() => {
    const previousFilters = previousSshBrowserFiltersRef.current

    for (const [tabId, browserState] of Object.entries(sshBrowserStates)) {
      const previousFilterQuery = previousFilters.get(tabId)

      if (previousFilterQuery !== undefined && previousFilterQuery !== browserState.filterQuery) {
        const listElement = sshBrowserListElementsRef.current.get(tabId)

        if (listElement) {
          listElement.scrollTop = 0
        }
      }

      previousFilters.set(tabId, browserState.filterQuery)
    }

    for (const tabId of Array.from(previousFilters.keys())) {
      if (sshBrowserStates[tabId] !== undefined) {
        continue
      }

      previousFilters.delete(tabId)
      sshBrowserListElementsRef.current.delete(tabId)
    }
  }, [sshBrowserStates])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  useEffect(() => {
    applyTerminalTheme(getTerminalThemeForSearchState(isSearchOpen))
  }, [applyTerminalTheme, getTerminalThemeForSearchState, isSearchOpen])

  useEffect(() => {
    applyTerminalTypography(
      selectedTerminalFontOption.fontFamily,
      selectedTerminalFontSize,
      selectedTerminalFontWeight,
      selectedTerminalLineHeight
    )
  }, [
    applyTerminalTypography,
    selectedTerminalFontOption,
    selectedTerminalFontSize,
    selectedTerminalFontWeight,
    selectedTerminalLineHeight
  ])

  useEffect(() => {
    applyTerminalCursorSettings(
      selectedTerminalCursorBlink,
      selectedTerminalCursorStyle,
      selectedTerminalCursorWidth
    )
  }, [
    applyTerminalCursorSettings,
    selectedTerminalCursorBlink,
    selectedTerminalCursorStyle,
    selectedTerminalCursorWidth
  ])

  useEffect(() => {
    if (!hasHydratedSettings) {
      return
    }

    void window.api.settings
      .save(
        createAppSettings({
          defaultNewTabDirectory,
          quickCommands,
          sftpBrowserOpenMode: selectedSftpBrowserOpenMode,
          startupMode: selectedStartupMode,
          terminalColorSchemeId: selectedTerminalColorSchemeId,
          terminalCursorBlink: selectedTerminalCursorBlink,
          terminalCursorColor: selectedTerminalCursorColor,
          terminalSelectionColor: selectedTerminalSelectionColor,
          terminalCursorStyle: selectedTerminalCursorStyle,
          terminalCursorWidth: selectedTerminalCursorWidth,
          terminalFontFamilyId: selectedTerminalFontFamilyId,
          terminalFontSize: selectedTerminalFontSize,
          terminalFontWeight: selectedTerminalFontWeight,
          terminalLineHeight: selectedTerminalLineHeight
        })
      )
      .catch((error) => {
        console.error('Unable to save the app settings.', error)
      })
  }, [
    defaultNewTabDirectory,
    hasHydratedSettings,
    quickCommands,
    selectedSftpBrowserOpenMode,
    selectedStartupMode,
    selectedTerminalColorSchemeId,
    selectedTerminalCursorBlink,
    selectedTerminalCursorColor,
    selectedTerminalSelectionColor,
    selectedTerminalCursorStyle,
    selectedTerminalCursorWidth,
    selectedTerminalFontFamilyId,
    selectedTerminalFontSize,
    selectedTerminalFontWeight,
    selectedTerminalLineHeight
  ])

  useEffect(() => {
    if (!activeTabId) {
      return
    }

    const paneId = getActivePaneIdForTab(activeTabId)

    if (!paneId) {
      return
    }

    maybeReconnectSshPane(activeTabId, paneId)
  }, [activeTabId, getActivePaneIdForTab, maybeReconnectSshPane])

  useEffect(() => {
    const reconnectActiveSshTab = (): void => {
      const currentActiveTabId = activeTabIdRef.current

      if (!currentActiveTabId) {
        return
      }

      const paneId = getActivePaneIdForTab(currentActiveTabId)

      if (!paneId) {
        return
      }

      maybeReconnectSshPane(currentActiveTabId, paneId)
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
  }, [getActivePaneIdForTab, maybeReconnectSshPane])

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
    if (!hasHydratedSettings || hasInitializedSessionRestoreRef.current) {
      return
    }

    hasInitializedSessionRestoreRef.current = true

    if (selectedStartupMode === 'startClean') {
      initialSessionSnapshotRef.current = null
      setIsSessionHydrated(true)
      return
    }

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

        const pendingInitialPaneState = pendingInitialPaneStateRef.current

        for (const tab of snapshot.tabs) {
          pendingInitialPaneState.set(tab.id, buildCreateTabOptionsFromSessionTab(tab))
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
  }, [hasHydratedSettings, selectedStartupMode])

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
    const disposeNavigationShortcut = window.api.terminal.onNavigationShortcut((event) => {
      writeActiveTerminalShortcut(event.data)
    })

    return () => {
      disposeNavigationShortcut()
    }
  }, [writeActiveTerminalShortcut])

  useEffect(() => {
    const disposeData = window.api.terminal.onData((event) => {
      const paneId = terminalToPaneRef.current.get(event.terminalId)

      if (!paneId) {
        return
      }

      const runtime = runtimesRef.current.get(paneId)
      const tabId = paneToTabRef.current.get(paneId)

      if (!runtime || runtime.disposed || !tabId) {
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
        updatePane(tabId, paneId, (pane) => {
          if (pane.restoreState.kind !== 'ssh') {
            return typeof pane.reconnectAttempt === 'number'
              ? {
                  ...pane,
                  reconnectAttempt: undefined
                }
              : pane
          }

          const nextRestoreState =
            pane.restoreState.cwd === cwd
              ? pane.restoreState
              : {
                  ...pane.restoreState,
                  cwd
                }

          if (nextRestoreState === pane.restoreState && pane.reconnectAttempt === undefined) {
            return pane
          }

          return {
            ...pane,
            reconnectAttempt: undefined,
            restoreState: nextRestoreState
          }
        })
      }

      if (
        isSearchOpenRef.current &&
        searchQueryRef.current !== '' &&
        activeTabIdRef.current === tabId &&
        getActivePaneIdForTab(tabId) === paneId
      ) {
        queueSearchRefresh(tabId, searchRefreshDebounceMs)
      }
    })

    const disposeExit = window.api.terminal.onExit((event) => {
      const paneId = terminalToPaneRef.current.get(event.terminalId)

      if (!paneId) {
        return
      }

      const runtime = runtimesRef.current.get(paneId)
      const tabId = paneToTabRef.current.get(paneId)

      terminalToPaneRef.current.delete(event.terminalId)
      pendingTerminalStateRef.current.delete(event.terminalId)
      sshCwdSequenceBuffersRef.current.delete(event.terminalId)

      if (!runtime || runtime.disposed || !tabId) {
        return
      }

      const shouldReconnectActiveSshTab =
        tabId === activeTabIdRef.current &&
        getActivePaneIdForTab(tabId) === paneId &&
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        (event.exitCode !== 0 || typeof event.signal === 'number')

      runtime.closed = true
      runtime.terminalId = null
      runtime.terminal.options.disableStdin = true
      runtime.terminal.write(`\r\n[process exited with code ${event.exitCode}]\r\n`)

      updatePane(tabId, paneId, (pane) => ({
        ...pane,
        exitCode: event.exitCode,
        reconnectAttempt: undefined,
        status: 'closed',
        terminalId: null
      }))

      if (shouldReconnectActiveSshTab) {
        scheduleSshPaneReconnect(tabId, paneId)
      }
    })

    return () => {
      disposeData()
      disposeExit()
    }
  }, [getActivePaneIdForTab, queueSearchRefresh, scheduleSshPaneReconnect, updatePane])

  useEffect(() => {
    const disposeCwd = window.api.terminal.onCwd((event) => {
      const paneId = terminalToPaneRef.current.get(event.terminalId)

      if (!paneId) {
        pendingTerminalStateRef.current.set(event.terminalId, {
          cwd: event.cwd,
          title: event.title
        })
        return
      }

      const tabId = paneToTabRef.current.get(paneId)

      if (!tabId) {
        return
      }

      updatePane(tabId, paneId, (pane) => {
        const nextRestoreState =
          pane.restoreState.kind === 'local' && pane.restoreState.cwd !== event.cwd
            ? {
                cwd: event.cwd,
                kind: 'local' as const
              }
            : pane.restoreState

        if (pane.title === event.title && nextRestoreState === pane.restoreState) {
          return pane
        }

        return {
          ...pane,
          restoreState: nextRestoreState,
          title: event.title
        }
      })
    })

    return () => {
      disposeCwd()
    }
  }, [updatePane])

  useEffect(() => {
    const disposeFindRequested = window.api.terminal.onFindRequested(() => {
      if (isQuickOpenOpen || isSshConfigDialogOpen || isSettingsDialogOpen) {
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
  }, [isQuickOpenOpen, isSettingsDialogOpen, isSshConfigDialogOpen, openSearch])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const usesPrimaryModifier = event.metaKey || event.ctrlKey
      const activeElement = document.activeElement
      const isSearchInputTarget = searchInputRef.current === activeElement
      const isQuickOpenInputTarget = quickOpenInputRef.current === activeElement

      if (usesPrimaryModifier && event.key.toLowerCase() === 'p') {
        if (isSettingsDialogOpen || isSshConfigDialogOpen) {
          return
        }

        if (
          isEditableElement(activeElement) &&
          !isSearchInputTarget &&
          !isQuickOpenInputTarget &&
          !isXtermHelperTextarea(activeElement)
        ) {
          return
        }

        event.preventDefault()
        openQuickOpen()
        return
      }

      if (isQuickOpenOpen || isSettingsDialogOpen || isSshConfigDialogOpen) {
        return
      }

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

      if (usesPrimaryModifier && (event.key === ',' || event.code === 'Comma')) {
        event.preventDefault()
        setIsSshMenuOpen(false)
        setIsSettingsDialogOpen(true)
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
  }, [
    activateTab,
    closeTab,
    createTab,
    isQuickOpenOpen,
    isSettingsDialogOpen,
    isSshConfigDialogOpen,
    openQuickOpen,
    selectAdjacentTab
  ])

  useEffect(() => {
    if (!isQuickOpenOpen) {
      return
    }

    window.requestAnimationFrame(() => {
      quickOpenInputRef.current?.focus()
      quickOpenInputRef.current?.select()
    })
  }, [isQuickOpenOpen])

  useEffect(() => {
    if (!isQuickOpenOpen) {
      return
    }

    setQuickOpenSelectedIndex(0)
  }, [isQuickOpenOpen, quickOpenQuery])

  useEffect(() => {
    if (!isQuickOpenOpen) {
      return
    }

    if (!isSettingsDialogOpen && !isSshConfigDialogOpen) {
      return
    }

    closeQuickOpen(false)
  }, [closeQuickOpen, isQuickOpenOpen, isSettingsDialogOpen, isSshConfigDialogOpen])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }

    const currentActivePaneId = activeTabId ? getActivePaneIdForTab(activeTabId) : null

    if (!activeTabId || !currentActivePaneId) {
      return
    }

    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }, [activeTabId, getActivePaneIdForTab, isSearchOpen])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }

    if (searchQuery === '') {
      return
    }

    const currentActivePaneId = activeTabId ? getActivePaneIdForTab(activeTabId) : null

    if (!currentActivePaneId) {
      return
    }

    queueSearchRefresh(activeTabId, 0)
  }, [activeTabId, getActivePaneIdForTab, isSearchOpen, queueSearchRefresh, searchQuery])

  useEffect(() => {
    const currentActivePaneId = activeTabId ? getActivePaneIdForTab(activeTabId) : null

    if (activeTabId && !currentActivePaneId) {
      return
    }

    syncActiveTabLayout(activeTabId, true)
    syncTabStripPosition(activeTabId)
  }, [activeTabId, getActivePaneIdForTab, syncActiveTabLayout, syncTabStripPosition, tabs.length])

  useEffect(() => {
    const activeSshBrowserState = activeTabId ? (sshBrowserStates[activeTabId] ?? null) : null

    if (!activeSshBrowserState) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      if (tabContextMenu) {
        closeTabContextMenu()
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
    closeTabContextMenu,
    closeTerminalContextMenu,
    closeSshBrowserContextMenu,
    closeSshBrowserForTab,
    sshBrowserContextMenu,
    sshBrowserStates,
    tabContextMenu,
    terminalContextMenu
  ])

  useEffect(() => {
    if (!tabContextMenu) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (tabContextMenuRef.current?.contains(event.target as Node)) {
        return
      }

      closeTabContextMenu()
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }

      closeTabContextMenu()
    }

    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('keydown', handleKeyDown, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [closeTabContextMenu, tabContextMenu])

  useEffect(() => {
    if (!tabContextMenu) {
      return
    }

    if (
      activeTabId !== tabContextMenu.tabId ||
      !tabs.some((tab) => tab.id === tabContextMenu.tabId)
    ) {
      closeTabContextMenu()
    }
  }, [activeTabId, closeTabContextMenu, tabContextMenu, tabs])

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
      !runtimesRef.current.has(terminalContextMenu.paneId)
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
    if (!sshBrowserCreateDialogState) {
      return
    }

    if (
      activeTabId !== sshBrowserCreateDialogState.tabId ||
      sshBrowserStates[sshBrowserCreateDialogState.tabId] === undefined
    ) {
      closeSshBrowserCreateDialog()
    }
  }, [activeTabId, closeSshBrowserCreateDialog, sshBrowserCreateDialogState, sshBrowserStates])

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
    const pendingInitialPaneState = pendingInitialPaneStateRef.current

    return () => {
      isUnmountingRef.current = true
      cancelQueuedSearchRefresh()

      for (const paneId of Array.from(runtimes.keys())) {
        disposePaneRuntime(paneId, true)
      }

      pendingInitialPaneState.clear()
      hostElements.clear()
    }
  }, [cancelQueuedSearchRefresh, disposePaneRuntime])

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

  const writeDroppedPathsToActiveTerminal = useCallback(
    (paths: string[]): void => {
      if (paths.length === 0) {
        return
      }

      const activeTabId = activeTabIdRef.current

      if (!activeTabId) {
        return
      }

      const runtime = getPaneRuntime(getActivePaneIdForTab(activeTabId))

      if (!runtime || runtime.closed || runtime.disposed || runtime.terminalId === null) {
        return
      }

      const escapedPaths = paths.map((path) => quotePathForShell(path))
      window.api.terminal.write(runtime.terminalId, `${escapedPaths.join(' ')} `)
      runtime.terminal.focus()
    },
    [getActivePaneIdForTab, getPaneRuntime]
  )

  const writeTerminalStatusToTab = useCallback(
    (tabId: string, message: string): void => {
      const runtime = getPaneRuntime(getActivePaneIdForTab(tabId))

      if (!runtime || runtime.closed || runtime.disposed) {
        return
      }

      runtime.terminal.write(`\r\n${message}\r\n`)
      runtime.terminal.focus()
    },
    [getActivePaneIdForTab, getPaneRuntime]
  )

  const uploadLocalPathsToSshTarget = useCallback(
    (tabId: string, configId: string, targetPath: string, paths: string[]): void => {
      const normalizedTargetPath = targetPath.trim()
      const normalizedPaths = paths.map((path) => path.trim()).filter((path) => path !== '')

      if (normalizedTargetPath === '' || normalizedPaths.length === 0) {
        return
      }

      const browserState = sshBrowserStatesRef.current[tabId]

      if (browserState?.path === normalizedTargetPath) {
        updateSshBrowserState(tabId, (currentState) => ({
          ...currentState,
          errorMessage: null,
          isLoading: true
        }))
      }

      void window.api.ssh
        .uploadPaths(configId, normalizedTargetPath, normalizedPaths)
        .then(() => {
          const nextBrowserState = sshBrowserStatesRef.current[tabId]

          if (nextBrowserState?.path === normalizedTargetPath) {
            loadSshDirectory(nextBrowserState.configId, normalizedTargetPath, tabId)
          } else if (browserState?.path === normalizedTargetPath) {
            updateSshBrowserState(tabId, (currentState) => ({
              ...currentState,
              errorMessage: null,
              isLoading: false
            }))
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          const fallbackMessage = message || 'Unable to upload the selected files.'

          if (browserState?.path === normalizedTargetPath) {
            updateSshBrowserState(tabId, (currentState) => ({
              ...currentState,
              errorMessage: fallbackMessage,
              isLoading: false
            }))
          }

          writeTerminalStatusToTab(tabId, `Upload failed: ${fallbackMessage}`)
        })
    },
    [loadSshDirectory, updateSshBrowserState, writeTerminalStatusToTab]
  )

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
      const targetPath = (browserState?.path ?? activeTab.restoreState.cwd ?? '').trim()

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

      uploadLocalPathsToSshTarget(
        currentActiveTabId,
        activeTab.restoreState.configId,
        targetPath,
        paths
      )
    },
    [updateSshBrowserState, uploadLocalPathsToSshTarget, writeTerminalStatusToTab]
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

  const handleOpenSettingsDialog = useCallback((): void => {
    setIsSshMenuOpen(false)
    setIsSettingsDialogOpen(true)
  }, [])

  const handleCloseSettingsDialog = useCallback((): void => {
    setIsSettingsDialogOpen(false)
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

  const runQuickCommand = useCallback(
    (quickCommand: QuickCommand): void => {
      const currentActiveTabId = activeTabIdRef.current

      if (!currentActiveTabId) {
        return
      }

      const runtime = getPaneRuntime(getActivePaneIdForTab(currentActiveTabId))

      if (!runtime || runtime.closed || runtime.disposed || runtime.terminalId === null) {
        return
      }

      window.api.terminal.write(
        runtime.terminalId,
        getQuickCommandTerminalInput(quickCommand.command)
      )
      runtime.terminal.focus()
    },
    [getActivePaneIdForTab, getPaneRuntime]
  )

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activePane = activeTab ? getActivePane(activeTab) : null
  const activePaneId = activePane?.id ?? null
  const canRunQuickCommands = activePane?.status === 'ready' && activePane.terminalId !== null
  const canSplitActivePaneIntoColumns = activeTab ? canSplitTabPane(activeTab, 'columns') : false
  const canSplitActivePaneIntoRows = activeTab ? canSplitTabPane(activeTab, 'rows') : false
  const canCloseActivePane = activeTab ? canCloseTabPane(activeTab) : false
  const activeLocalTabCwd =
    activeTab?.restoreState.kind === 'local' ? (activeTab.restoreState.cwd ?? null) : null
  const activeSshConfigId =
    activeTab?.restoreState.kind === 'ssh' ? activeTab.restoreState.configId : null
  const activeSshCwd =
    activeTab?.restoreState.kind === 'ssh' ? (activeTab.restoreState.cwd ?? null) : null
  const activeSshBrowserPath =
    activeTab?.restoreState.kind === 'ssh' ? (activeTab.restoreState.browserPath ?? null) : null
  const preferredSshBrowserOpenPath =
    selectedSftpBrowserOpenMode === 'openCurrentFolder'
      ? (activeSshCwd ?? activeSshBrowserPath ?? null)
      : (activeSshBrowserPath ?? activeSshCwd ?? null)
  const activeSshTabId = activeTab?.restoreState.kind === 'ssh' ? activeTab.id : null
  const activeSshBrowserState = activeTabId ? (sshBrowserStates[activeTabId] ?? null) : null
  const activeSshBrowserId = activeSshBrowserState
    ? `ssh-browser-${activeSshBrowserState.tabId}`
    : undefined
  const activeSshBrowserWidth = activeTabId
    ? (sshBrowserWidths[activeTabId] ?? defaultSshBrowserWidth)
    : defaultSshBrowserWidth
  const sshBrowserCreateDialogBrowserState = sshBrowserCreateDialogState
    ? (sshBrowserStates[sshBrowserCreateDialogState.tabId] ?? null)
    : null
  const terminalContextMenuTab = terminalContextMenu
    ? (tabs.find((tab) => tab.id === terminalContextMenu.tabId) ?? null)
    : null
  const terminalContextMenuPane =
    terminalContextMenu && terminalContextMenuTab
      ? getPaneById(terminalContextMenuTab, terminalContextMenu.paneId)
      : null
  const tabContextMenuTab = tabContextMenu
    ? (tabs.find((tab) => tab.id === tabContextMenu.tabId) ?? null)
    : null
  const canSplitTabContextIntoColumns = tabContextMenuTab
    ? canSplitTabPane(tabContextMenuTab, 'columns')
    : false
  const canSplitTabContextIntoRows = tabContextMenuTab
    ? canSplitTabPane(tabContextMenuTab, 'rows')
    : false
  const canCloseTabContextPane = tabContextMenuTab ? canCloseTabPane(tabContextMenuTab) : false
  const terminalContextMenuLocalEditPath =
    terminalContextMenuPane?.restoreState.kind === 'local' && terminalContextMenu
      ? getTerminalQuickLocalEditPath(terminalContextMenuPane, terminalContextMenu.selectionText)
      : null
  const canEditTerminalContextSelection =
    terminalContextMenu?.quickDownloadAction !== null || terminalContextMenuLocalEditPath !== null
  const mountedSshBrowserTabs = tabs.filter((tab) => sshBrowserStates[tab.id] !== undefined)
  const hasMountedSshBrowsers = mountedSshBrowserTabs.length > 0
  const terminalWorkspaceStyle = {
    '--terminal-background':
      selectedTerminalTheme.background ?? defaultTerminalTheme.background ?? '#000000',
    ...(activeSshBrowserState ? { '--ssh-browser-width': `${activeSshBrowserWidth}px` } : {})
  } as CSSProperties
  const openCurrentFolderPath = activeSshBrowserState?.path ?? preferredSshBrowserOpenPath
  const openCurrentFolderTitle = activeSshConfigId
    ? openCurrentFolderPath
      ? `Browse ${openCurrentFolderPath}`
      : 'Browse remote files'
    : activeLocalTabCwd
      ? `Open ${activeLocalTabCwd}`
      : 'Current folder is not available yet'
  const openCurrentFolderAriaLabel = activeSshConfigId
    ? activeSshBrowserState
      ? 'Close SFTP browser'
      : 'Open SFTP browser'
    : 'Open current folder'
  const primaryModifierLabel = platformClassName === 'platform-macos' ? 'Cmd' : 'Ctrl'
  const sshServersById = useMemo(
    () => new Map(sshServers.map((server) => [server.id, server])),
    [sshServers]
  )
  const sortedSshServers = [...sshServers].sort((left, right) => {
    const nameDifference = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })

    if (nameDifference !== 0) {
      return nameDifference
    }

    return formatSshTarget(left).localeCompare(formatSshTarget(right), undefined, {
      sensitivity: 'base'
    })
  })
  const quickOpenCommands: QuickOpenCommandItem[] = [
    {
      action: handleOpenSettingsDialog,
      description: 'Open application settings.',
      group: 'commands',
      icon: Settings,
      id: 'settings',
      keywords: ['settings', 'preferences', 'config', 'options'],
      shortcut: [primaryModifierLabel, ','],
      title: 'Settings'
    },
    {
      action: createTab,
      description: 'Create a new local terminal tab.',
      group: 'commands',
      icon: Plus,
      id: 'new-tab',
      keywords: ['new', 'new tab', 'tab', 'terminal', 'shell', 'nwe', 'nwe tab'],
      shortcut: [primaryModifierLabel, 'T'],
      title: 'New Tab'
    },
    {
      action: () => {
        if (!activeTabId) {
          return
        }

        createSplitPaneForTab(activeTabId, 'columns')
      },
      description: 'Split the active tab into side-by-side panes.',
      disabled: !canSplitActivePaneIntoColumns,
      group: 'commands',
      icon: Columns2,
      id: 'split-right',
      keywords: ['split', 'pane', 'vertical split', 'side by side', 'columns'],
      shortcut: [],
      title: 'Split Right'
    },
    {
      action: () => {
        if (!activeTabId) {
          return
        }

        createSplitPaneForTab(activeTabId, 'rows')
      },
      description: 'Split the active tab into stacked panes.',
      disabled: !canSplitActivePaneIntoRows,
      group: 'commands',
      icon: Rows2,
      id: 'split-down',
      keywords: ['split', 'pane', 'horizontal split', 'stacked', 'rows'],
      shortcut: [],
      title: 'Split Down'
    },
    {
      action: clearActiveTerminalContent,
      description: 'Clear the visible terminal output in the active pane.',
      disabled: activePaneId === null,
      group: 'commands',
      icon: BrushCleaning,
      id: 'clean',
      keywords: ['clean', 'clear', 'erase', 'terminal'],
      shortcut: [],
      title: 'Clean'
    },
    {
      action: () => {
        if (!activeTabId) {
          return
        }

        closeActivePaneForTab(activeTabId)
      },
      description: 'Close the active pane without closing the tab.',
      disabled: !canCloseActivePane,
      group: 'commands',
      icon: X,
      id: 'close-pane',
      keywords: ['close pane', 'remove pane', 'pane'],
      shortcut: [],
      title: 'Close Pane'
    },
    {
      action: () => {
        if (!activeTabId) {
          return
        }

        closeTab(activeTabId)
      },
      description: activeTab ? `Close ${activeTab.title}.` : 'Close the current tab.',
      disabled: activeTabId === null,
      group: 'commands',
      icon: X,
      id: 'close-tab',
      keywords: ['close', 'tab', 'remove'],
      shortcut: [primaryModifierLabel, 'W'],
      title: 'Close Tab'
    },
    ...quickCommands.map((quickCommand) => ({
      action: () => runQuickCommand(quickCommand),
      description: canRunQuickCommands
        ? quickCommand.command
        : `${quickCommand.command} · Open or reconnect a terminal tab to run this command.`,
      disabled: !canRunQuickCommands,
      group: 'quickCommands' as const,
      icon: FileTerminal,
      id: `quick-command-${quickCommand.id}`,
      keywords: [
        'quick command',
        'saved command',
        'snippet',
        'run',
        quickCommand.title,
        quickCommand.command
      ],
      shortcut: [],
      title: quickCommand.title
    })),
    ...sortedSshServers.map((server) => {
      const target = formatSshTarget(server)
      const trimmedDescription = server.description.trim()

      return {
        action: () => handleConnectToSshServer(server),
        description: trimmedDescription ? `${trimmedDescription} · ${target}` : target,
        group: 'servers' as const,
        icon: Server,
        id: `ssh-server-${server.id}`,
        keywords: [
          'ssh',
          'server',
          'connect',
          server.name,
          server.host,
          server.username,
          String(server.port),
          target,
          trimmedDescription
        ].filter((keyword) => keyword !== ''),
        sshServerIcon: server.icon,
        shortcut: [],
        title: server.name
      }
    })
  ]
  const quickOpenNormalizedQuery = normalizeQuickOpenQuery(quickOpenQuery)
  const scoredQuickOpenCommands = quickOpenCommands.map((command, index) => ({
    command,
    index,
    score: getQuickOpenCommandScore(command, quickOpenNormalizedQuery)
  }))
  let nextQuickOpenResultIndex = 0
  const filteredQuickOpenCommandGroups = quickOpenCommandGroups
    .map((group) => {
      const items = scoredQuickOpenCommands
        .filter(
          ({ command, score }) =>
            command.group === group.id && (quickOpenNormalizedQuery === '' || score >= 0)
        )
        .sort((left, right) => {
          if (left.command.disabled !== right.command.disabled) {
            return Number(Boolean(left.command.disabled)) - Number(Boolean(right.command.disabled))
          }

          if (left.score !== right.score) {
            return right.score - left.score
          }

          return left.index - right.index
        })
        .map(({ command }) => ({
          command,
          index: nextQuickOpenResultIndex++
        }))

      return {
        group,
        items
      }
    })
    .filter(({ items }) => items.length > 0)
  const filteredQuickOpenCommands = filteredQuickOpenCommandGroups.flatMap(({ items }) =>
    items.map(({ command }) => command)
  )

  const executeQuickOpenCommand = useCallback(
    (command: QuickOpenCommandItem | undefined): void => {
      if (!command || command.disabled) {
        return
      }

      closeQuickOpen(false)
      command.action()
    },
    [closeQuickOpen]
  )

  useEffect(() => {
    if (filteredQuickOpenCommands.length === 0) {
      if (quickOpenSelectedIndex !== 0) {
        setQuickOpenSelectedIndex(0)
      }
      return
    }

    if (quickOpenSelectedIndex >= filteredQuickOpenCommands.length) {
      setQuickOpenSelectedIndex(filteredQuickOpenCommands.length - 1)
    }
  }, [filteredQuickOpenCommands.length, quickOpenSelectedIndex])

  useEffect(() => {
    if (!isQuickOpenOpen || filteredQuickOpenCommands.length === 0) {
      return
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      const selectedItem = quickOpenResultsRef.current?.querySelector<HTMLButtonElement>(
        '.quick-open-item.is-selected'
      )

      selectedItem?.scrollIntoView({
        block: 'nearest'
      })
    })

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [filteredQuickOpenCommands.length, isQuickOpenOpen, quickOpenSelectedIndex])

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

  const handleChangeSshBrowserFilterQuery = useCallback(
    (tabId: string, filterQuery: string): void => {
      updateSshBrowserState(tabId, (currentState) => ({
        ...currentState,
        filterQuery
      }))
    },
    [updateSshBrowserState]
  )

  const handleUploadToSshBrowser = useCallback(
    (browserState: SshBrowserState): void => {
      if (!browserState.path || browserState.isLoading) {
        return
      }

      updateSshBrowserState(browserState.tabId, (currentState) => ({
        ...currentState,
        errorMessage: null
      }))

      void window.api.shell
        .pickPaths({
          allowDirectories: true,
          allowFiles: true,
          buttonLabel: 'Upload',
          multiSelections: true,
          title: 'Select files or folders to upload'
        })
        .then((paths) => {
          if (paths.length === 0) {
            return
          }

          uploadLocalPathsToSshTarget(
            browserState.tabId,
            browserState.configId,
            browserState.path!,
            paths
          )
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)

          updateSshBrowserState(browserState.tabId, (currentState) => ({
            ...currentState,
            errorMessage: message || 'Unable to choose files to upload.'
          }))
        })
    },
    [updateSshBrowserState, uploadLocalPathsToSshTarget]
  )

  const handleCreateSshBrowserEntry = useCallback(
    (browserState: SshBrowserState, isDirectory: boolean): void => {
      if (!browserState.path || browserState.isLoading) {
        return
      }

      updateSshBrowserState(browserState.tabId, (currentState) => ({
        ...currentState,
        errorMessage: null
      }))
      setSshBrowserCreateDialogState({
        errorMessage: null,
        isDirectory,
        name: '',
        tabId: browserState.tabId
      })
    },
    [updateSshBrowserState]
  )

  const handleChangeSshBrowserCreateDialogName = useCallback((name: string): void => {
    setSshBrowserCreateDialogState((currentState) =>
      currentState
        ? {
            ...currentState,
            errorMessage: null,
            name
          }
        : currentState
    )
  }, [])

  const handleSubmitSshBrowserCreateDialog = useCallback((): void => {
    const currentDialogState = sshBrowserCreateDialogState

    if (!currentDialogState) {
      return
    }

    const browserState = sshBrowserStatesRef.current[currentDialogState.tabId]

    if (!browserState?.path || browserState.isLoading) {
      setSshBrowserCreateDialogState((previousState) =>
        previousState
          ? {
              ...previousState,
              errorMessage: 'Remote folder is not available yet.'
            }
          : previousState
      )
      return
    }

    const nextName = currentDialogState.name.trim()
    const validationError = getSshBrowserEntryNameError(nextName)

    if (validationError) {
      setSshBrowserCreateDialogState((previousState) =>
        previousState
          ? {
              ...previousState,
              errorMessage: validationError
            }
          : previousState
      )
      return
    }

    const entryLabel = currentDialogState.isDirectory ? 'folder' : 'file'
    const remotePath = joinRemoteDirectoryPath(browserState.path, nextName)

    closeSshBrowserCreateDialog()
    void runSshBrowserMutation(
      browserState,
      () =>
        window.api.ssh.createPath(
          browserState.configId,
          remotePath,
          currentDialogState.isDirectory
        ),
      `Unable to create this remote ${entryLabel}.`
    )
  }, [closeSshBrowserCreateDialog, runSshBrowserMutation, sshBrowserCreateDialogState])

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
      closeTabContextMenu()

      const menuPadding = 12
      const menuWidth = 172
      const menuItemCount = canEditSshRemoteFile(entry) ? 4 : 3
      const menuHeight = 12 + menuItemCount * 36
      const maxX = Math.max(menuPadding, window.innerWidth - menuWidth - menuPadding)
      const maxY = Math.max(menuPadding, window.innerHeight - menuHeight - menuPadding)

      setSshBrowserContextMenu({
        entry,
        tabId: browserState.tabId,
        x: Math.min(Math.max(event.clientX, menuPadding), maxX),
        y: Math.min(Math.max(event.clientY, menuPadding), maxY)
      })
    },
    [closeTabContextMenu]
  )

  const handleOpenTabContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, tabId: string): void => {
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)

      if (!tab) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const menuPadding = 12
      const menuWidth = 204
      const menuHeight = 164
      const maxX = Math.max(menuPadding, window.innerWidth - menuWidth - menuPadding)
      const maxY = Math.max(menuPadding, window.innerHeight - menuHeight - menuPadding)

      setIsSshMenuOpen(false)
      closeTerminalContextMenu()
      closeSshBrowserContextMenu()
      activateTab(tabId)
      setTabContextMenu({
        tabId,
        x: Math.min(Math.max(event.clientX, menuPadding), maxX),
        y: Math.min(Math.max(event.clientY, menuPadding), maxY)
      })
    },
    [activateTab, closeSshBrowserContextMenu, closeTerminalContextMenu]
  )

  const handleOpenTerminalContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, tabId: string, paneId: string): void => {
      const runtime = getPaneRuntime(paneId)

      if (!runtime || runtime.disposed) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      closeTabContextMenu()

      const selectionText = runtime.terminal.getSelection()
      const tab = tabsRef.current.find((currentTab) => currentTab.id === tabId)
      const pane = tab ? getPaneById(tab, paneId) : null
      const quickChmodRunAction = pane ? getTerminalQuickChmodRunAction(pane, selectionText) : null
      const quickDownloadAction = pane ? getTerminalQuickDownloadAction(pane, selectionText) : null
      const quickLocalEditPath = pane ? getTerminalQuickLocalEditPath(pane, selectionText) : null
      const quickExtractAction = pane ? getTerminalQuickExtractAction(pane, selectionText) : null
      const hasQuickEditAction =
        pane?.restoreState.kind === 'ssh'
          ? quickDownloadAction !== null
          : quickLocalEditPath !== null
      const quickActionCount =
        Number(Boolean(quickChmodRunAction)) +
        Number(Boolean(quickDownloadAction)) +
        Number(Boolean(hasQuickEditAction)) +
        Number(Boolean(quickExtractAction))

      const menuPadding = 12
      const menuWidth = 204
      const menuHeight = 256 + quickActionCount * 36
      const maxX = Math.max(menuPadding, window.innerWidth - menuWidth - menuPadding)
      const maxY = Math.max(menuPadding, window.innerHeight - menuHeight - menuPadding)

      activatePane(tabId, paneId, false)
      setTerminalContextMenu({
        paneId,
        quickChmodRunAction,
        quickDownloadAction,
        quickExtractAction,
        selectionText,
        tabId,
        x: Math.min(Math.max(event.clientX, menuPadding), maxX),
        y: Math.min(Math.max(event.clientY, menuPadding), maxY)
      })
    },
    [activatePane, closeTabContextMenu, getPaneRuntime]
  )

  const handleSplitTabFromContextMenu = useCallback(
    (requestedOrientation: PaneSplitOrientation): void => {
      const currentMenu = tabContextMenu

      if (!currentMenu) {
        return
      }

      createSplitPaneForTab(currentMenu.tabId, requestedOrientation)
      closeTabContextMenu()
    },
    [closeTabContextMenu, createSplitPaneForTab, tabContextMenu]
  )

  const handleClosePaneFromTabContextMenu = useCallback((): void => {
    const currentMenu = tabContextMenu

    if (!currentMenu) {
      return
    }

    closeActivePaneForTab(currentMenu.tabId)
    closeTabContextMenu()
  }, [closeActivePaneForTab, closeTabContextMenu, tabContextMenu])

  const handleCloseTabFromContextMenu = useCallback((): void => {
    const currentMenu = tabContextMenu

    if (!currentMenu) {
      return
    }

    closeTabContextMenu()
    closeTab(currentMenu.tabId)
  }, [closeTab, closeTabContextMenu, tabContextMenu])

  const openTextEditorFile = useCallback(
    (
      options:
        | {
            kind: 'local'
            path: string
            tabId: string
          }
        | {
            configId: string
            kind: 'ssh'
            path: string
            tabId: string
          }
    ): boolean => {
      if (!closeSshRemoteEditor()) {
        return false
      }

      if (options.kind === 'ssh') {
        updateSshBrowserState(options.tabId, (currentState) => ({
          ...currentState,
          errorMessage: null,
          isLoading: true
        }))
      }

      setSshRemoteEditorLoadingState({
        fileName: getRemotePathBaseName(options.path),
        path: options.path
      })

      const readRequest: Promise<TextEditorFile> =
        options.kind === 'ssh'
          ? window.api.ssh.readTextFile(options.configId, options.path)
          : window.api.shell.readTextFile(options.path)

      void readRequest
        .then((file) => {
          setSshRemoteEditorLoadingState(null)
          const nextEditorState: SshRemoteEditorState =
            options.kind === 'ssh'
              ? {
                  configId: options.configId,
                  content: file.content,
                  errorMessage: null,
                  initialContent: file.content,
                  isSaving: false,
                  kind: 'ssh',
                  lineEnding: detectSshRemoteEditorLineEnding(file.content),
                  path: file.path,
                  size: file.size,
                  tabId: options.tabId
                }
              : {
                  content: file.content,
                  errorMessage: null,
                  initialContent: file.content,
                  isSaving: false,
                  kind: 'local',
                  lineEnding: detectSshRemoteEditorLineEnding(file.content),
                  path: file.path,
                  size: file.size,
                  tabId: options.tabId
                }

          setSshRemoteEditorState(nextEditorState)

          if (options.kind === 'ssh') {
            updateSshBrowserState(options.tabId, (currentState) => ({
              ...currentState,
              errorMessage: null,
              isLoading: false
            }))
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          setSshRemoteEditorLoadingState(null)

          if (options.kind === 'ssh') {
            updateSshBrowserState(options.tabId, (currentState) => ({
              ...currentState,
              errorMessage: message || 'Unable to open this remote file.',
              isLoading: false
            }))
          } else {
            window.alert(message || 'Unable to open this local file.')
          }

          console.error(`Unable to open ${options.kind} file "${options.path}".`, error)
        })

      return true
    },
    [closeSshRemoteEditor, updateSshBrowserState]
  )

  const handleCopyTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)

    if (!runtime || runtime.disposed || !runtime.terminal.hasSelection()) {
      closeTerminalContextMenu()
      return
    }

    window.api.clipboard.writeText(runtime.terminal.getSelection())
    runtime.terminal.focus()
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, getPaneRuntime, terminalContextMenu])

  const handleSearchTerminalSelectionWithGoogle = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)
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
  }, [closeTerminalContextMenu, getPaneRuntime, terminalContextMenu])

  const handleEditTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      closeTerminalContextMenu()
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)
    const tab = tabsRef.current.find((currentTab) => currentTab.id === currentMenu.tabId)
    const pane = tab ? getPaneById(tab, currentMenu.paneId) : null

    if (!runtime || runtime.disposed || !tab || !pane) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.focus()

    if (currentMenu.quickDownloadAction) {
      const didOpen = openTextEditorFile({
        configId: currentMenu.quickDownloadAction.configId,
        kind: 'ssh',
        path: currentMenu.quickDownloadAction.remotePath,
        tabId: currentMenu.tabId
      })

      if (!didOpen) {
        return
      }

      closeTerminalContextMenu()
      return
    }

    const localPath = getTerminalQuickLocalEditPath(pane, currentMenu.selectionText)

    if (!localPath) {
      closeTerminalContextMenu()
      return
    }

    const didOpen = openTextEditorFile({
      kind: 'local',
      path: localPath,
      tabId: currentMenu.tabId
    })

    if (!didOpen) {
      return
    }

    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, getPaneRuntime, openTextEditorFile, terminalContextMenu])

  const handleDownloadTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu?.quickDownloadAction) {
      closeTerminalContextMenu()
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)

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
  }, [closeTerminalContextMenu, getPaneRuntime, terminalContextMenu])

  const handleExtractTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu?.quickExtractAction) {
      closeTerminalContextMenu()
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)

    if (!runtime || runtime.closed || runtime.disposed || runtime.terminalId === null) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.clearSelection()
    runtime.terminal.focus()
    runtime.terminal.input(`${currentMenu.quickExtractAction.command}\r`)
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, getPaneRuntime, terminalContextMenu])

  const handleChmodRunTerminalSelection = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu?.quickChmodRunAction) {
      closeTerminalContextMenu()
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)

    if (!runtime || runtime.closed || runtime.disposed || runtime.terminalId === null) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.clearSelection()
    runtime.terminal.focus()
    runtime.terminal.input(`${currentMenu.quickChmodRunAction.command}\r`)
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, getPaneRuntime, terminalContextMenu])

  const handlePasteIntoTerminal = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)

    if (!runtime || runtime.disposed) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.focus()
    runtime.terminal.paste(window.api.clipboard.readText())
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, getPaneRuntime, terminalContextMenu])

  const handleSelectAllTerminalContent = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    const runtime = getPaneRuntime(currentMenu.paneId)

    if (!runtime || runtime.disposed) {
      closeTerminalContextMenu()
      return
    }

    runtime.terminal.focus()
    runtime.terminal.selectAll()
    closeTerminalContextMenu()
  }, [closeTerminalContextMenu, getPaneRuntime, terminalContextMenu])

  const handleClearTerminalContent = useCallback((): void => {
    const currentMenu = terminalContextMenu

    if (!currentMenu) {
      return
    }

    clearTerminalContent(currentMenu.paneId)
    closeTerminalContextMenu()
  }, [clearTerminalContent, closeTerminalContextMenu, terminalContextMenu])

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

  const handleOpenSshRemoteFile = useCallback(
    (browserState: SshBrowserState, entry: SshRemoteDirectoryEntry): void => {
      if (!browserState.path || browserState.isLoading || !canEditSshRemoteFile(entry)) {
        return
      }

      const remotePath = joinRemoteDirectoryPath(browserState.path, entry.name)
      const didOpen = openTextEditorFile({
        configId: browserState.configId,
        kind: 'ssh',
        path: remotePath,
        tabId: browserState.tabId
      })

      if (!didOpen) {
        return
      }

      closeSshBrowserContextMenu()
    },
    [closeSshBrowserContextMenu, openTextEditorFile]
  )

  const handleSshBrowserFileEntryKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLButtonElement>,
      browserState: SshBrowserState,
      entry: SshRemoteDirectoryEntry
    ): void => {
      if ((event.key !== 'Enter' && event.key !== ' ') || !canEditSshRemoteFile(entry)) {
        return
      }

      event.preventDefault()
      handleOpenSshRemoteFile(browserState, entry)
    },
    [handleOpenSshRemoteFile]
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
      const validationError = getSshBrowserEntryNameError(nextName)

      if (validationError) {
        updateSshBrowserState(browserState.tabId, (currentState) => ({
          ...currentState,
          errorMessage: validationError
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
  const uploadProgressTitle = sshUploadProgress ? getSshUploadProgressTitle(sshUploadProgress) : null

  return (
    <main className={`app-shell ${platformClassName}`}>
      <header className="window-titlebar">
        <div className="window-brand">
          <span className="window-title">TerminalFlow</span>
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
              const { restoreState } = tab
              const sshServerIcon =
                restoreState.kind === 'ssh'
                  ? (sshServers.find((server) => server.id === restoreState.configId)?.icon ??
                    defaultRendererSshServerIcon)
                  : null

              return (
                <ReorderableTab
                  closeTab={closeTab}
                  index={index}
                  isActive={isActive}
                  key={tab.id}
                  onActivateTab={activateTab}
                  onOpenContextMenu={handleOpenTabContextMenu}
                  sshServerIcon={sshServerIcon}
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
                uploadProgressTitle ? uploadProgressTitle.replace(/\n/g, '. ') : undefined
              }
              className={`window-upload-progress${isUploadCompleted ? ' is-complete' : ''}`}
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
              {uploadProgressTitle ? (
                <span aria-hidden="true" className="window-progress-tooltip">
                  {uploadProgressTitle}
                </span>
              ) : null}
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
            aria-label={openCurrentFolderAriaLabel}
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
                  onClick={() => handleOpenSettingsDialog()}
                  role="menuitem"
                  type="button"
                >
                  <Settings aria-hidden="true" className="tab-action-menu-icon" />
                  Settings
                </button>
                <button
                  className="tab-action-menu-item"
                  onClick={handleOpenSshConfigDialog}
                  role="menuitem"
                  type="button"
                >
                  <CirclePlus aria-hidden="true" className="tab-action-menu-icon" />
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
        style={terminalWorkspaceStyle}
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
              role="tabpanel"
            >
              <div
                className={`terminal-pane-grid${
                  tab.paneOrientation ? ` is-${tab.paneOrientation}` : ' is-single'
                }`}
                data-pane-count={tab.panes.length}
                style={
                  {
                    '--pane-count': String(tab.panes.length)
                  } as CSSProperties
                }
              >
                {tab.panes.map((pane) => {
                  const isActivePane = tab.activePaneId === pane.id
                  const paneStatusLabel = getTerminalItemStatusLabel(pane)
                  const paneMeta =
                    paneStatusLabel !== ''
                      ? paneStatusLabel
                      : (pane.restoreState.cwd ??
                        (pane.restoreState.kind === 'ssh' ? 'SSH' : 'Local'))

                  return (
                    <section
                      className={`terminal-pane${isActivePane ? ' is-active' : ''}${
                        pane.status === 'closed' ? ' is-closed' : ''
                      }`}
                      key={pane.id}
                      onPointerDown={() => activatePane(tab.id, pane.id, false)}
                    >
                      {tab.panes.length > 1 ? (
                        <header className="terminal-pane-header">
                          <div className="terminal-pane-copy">
                            <span className="terminal-pane-title">{pane.title}</span>
                            <span className="terminal-pane-meta">{paneMeta}</span>
                          </div>
                          <button
                            aria-label={`Close ${pane.title}`}
                            className="terminal-pane-close"
                            onClick={(event) => {
                              event.stopPropagation()
                              closePane(tab.id, pane.id)
                            }}
                            type="button"
                          >
                            <X aria-hidden="true" className="terminal-pane-close-icon" />
                          </button>
                        </header>
                      ) : null}
                      <div
                        className="terminal-pane-host"
                        onContextMenu={(event) =>
                          handleOpenTerminalContextMenu(event, tab.id, pane.id)
                        }
                        ref={(node) => {
                          if (!node) {
                            hostElementsRef.current.delete(pane.id)
                            return
                          }

                          hostElementsRef.current.set(pane.id, node)
                          initializePane(tab.id, pane, node)
                        }}
                      />
                    </section>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        {tabContextMenu ? (
          <div
            className="tab-context-menu"
            ref={tabContextMenuRef}
            role="menu"
            style={{
              left: tabContextMenu.x,
              top: tabContextMenu.y
            }}
          >
            <button
              className="tab-context-menu-item"
              disabled={!canSplitTabContextIntoColumns}
              onClick={() => handleSplitTabFromContextMenu('columns')}
              role="menuitem"
              type="button"
            >
              <span className="tab-context-menu-item-icon-shell">
                <Columns2 aria-hidden="true" className="tab-context-menu-icon" />
              </span>
              <span className="tab-context-menu-label">Split right</span>
            </button>
            <button
              className="tab-context-menu-item"
              disabled={!canSplitTabContextIntoRows}
              onClick={() => handleSplitTabFromContextMenu('rows')}
              role="menuitem"
              type="button"
            >
              <span className="tab-context-menu-item-icon-shell">
                <Rows2 aria-hidden="true" className="tab-context-menu-icon" />
              </span>
              <span className="tab-context-menu-label">Split down</span>
            </button>
            <div aria-hidden="true" className="tab-context-menu-divider" />
            <button
              className="tab-context-menu-item"
              disabled={!canCloseTabContextPane}
              onClick={handleClosePaneFromTabContextMenu}
              role="menuitem"
              type="button"
            >
              <span className="tab-context-menu-item-icon-shell">
                <X aria-hidden="true" className="tab-context-menu-icon" />
              </span>
              <span className="tab-context-menu-label">Close active pane</span>
            </button>
            <button
              className="tab-context-menu-item"
              onClick={handleCloseTabFromContextMenu}
              role="menuitem"
              type="button"
            >
              <span className="tab-context-menu-item-icon-shell">
                <X aria-hidden="true" className="tab-context-menu-icon" />
              </span>
              <span className="tab-context-menu-label">Close this tab</span>
            </button>
          </div>
        ) : null}
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
            {canEditTerminalContextSelection ||
            terminalContextMenu.quickChmodRunAction ||
            terminalContextMenu.quickDownloadAction ||
            terminalContextMenu.quickExtractAction ? (
              <>
                {canEditTerminalContextSelection ? (
                  <button
                    className="terminal-context-menu-item"
                    onClick={handleEditTerminalSelection}
                    role="menuitem"
                    title="Open in editor"
                    type="button"
                  >
                    <span className="terminal-context-menu-item-icon-shell">
                      <Pencil aria-hidden="true" className="terminal-context-menu-icon" />
                    </span>
                    <span className="terminal-context-menu-label">Open in editor</span>
                  </button>
                ) : null}
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
                {terminalContextMenu.quickChmodRunAction ? (
                  <button
                    className="terminal-context-menu-item"
                    onClick={handleChmodRunTerminalSelection}
                    role="menuitem"
                    title="Chmod +x and run"
                    type="button"
                  >
                    <span className="terminal-context-menu-item-icon-shell">
                      <Play aria-hidden="true" className="terminal-context-menu-icon" />
                    </span>
                    <span className="terminal-context-menu-label">Chmod +x &amp; Run</span>
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
              const sshServer = sshServersById.get(browserState.configId) ?? null
              const browserParentPath = browserState.path
                ? getRemoteDirectoryParentPath(browserState.path)
                : null
              const visibleEntries = getVisibleSshBrowserEntries(
                browserState.entries,
                browserState.filterQuery
              )
              const browserFilterQuery = browserState.filterQuery.trim()
              const browserDisplayPath = browserState.pendingPath ?? browserState.path
              const browserServerTarget = sshServer
                ? formatSshTarget(sshServer)
                : 'Remote workspace'
              const isNavigatingToDirectory =
                browserState.isLoading &&
                browserState.pendingPath !== null &&
                browserState.pendingPath !== browserState.path
              const browserSectionNote = browserState.errorMessage
                ? 'The directory listing could not be loaded.'
                : isNavigatingToDirectory
                  ? 'Opening folder...'
                  : browserState.isLoading
                    ? 'Refreshing remote directory...'
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
                      <div className="ssh-browser-title-row">
                        <SshServerIconGlyph
                          className="ssh-browser-server-icon"
                          icon={sshServer?.icon}
                        />
                        <div className="ssh-browser-title-copy">
                          <h2 className="ssh-browser-title">
                            {sshServer ? sshServer.name : 'SFTP Browser'}
                          </h2>
                          <p className="ssh-browser-description">
                            {sshServer ? browserServerTarget : 'Remote workspace'}
                          </p>
                        </div>
                      </div>
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
                    <div className="ssh-browser-toolbar-actions">
                      <button
                        aria-label="Open parent folder"
                        className="ssh-browser-toolbar-button is-icon"
                        disabled={!browserParentPath || browserState.isLoading}
                        onClick={() => handleOpenSshBrowserParent(browserState)}
                        title="Up"
                        type="button"
                      >
                        <ArrowUp aria-hidden="true" className="ssh-browser-toolbar-button-icon" />
                      </button>
                      <button
                        className="ssh-browser-toolbar-button"
                        disabled={!browserState.path || browserState.isLoading}
                        onClick={() => handleUploadToSshBrowser(browserState)}
                        type="button"
                      >
                        <Upload
                          aria-hidden="true"
                          className="ssh-browser-toolbar-button-icon ssh-browser-toolbar-button-icon-upload"
                        />
                        Upload
                      </button>
                      <button
                        aria-label="Create new file"
                        className="ssh-browser-toolbar-button is-icon"
                        disabled={!browserState.path || browserState.isLoading}
                        onClick={() => handleCreateSshBrowserEntry(browserState, false)}
                        title="New file"
                        type="button"
                      >
                        <FilePlus aria-hidden="true" className="ssh-browser-toolbar-button-icon" />
                      </button>
                      <button
                        aria-label="Create new folder"
                        className="ssh-browser-toolbar-button is-icon"
                        disabled={!browserState.path || browserState.isLoading}
                        onClick={() => handleCreateSshBrowserEntry(browserState, true)}
                        title="New folder"
                        type="button"
                      >
                        <FolderPlus
                          aria-hidden="true"
                          className="ssh-browser-toolbar-button-icon"
                        />
                      </button>
                      <button
                        aria-label={browserState.isLoading ? 'Refreshing...' : 'Refresh'}
                        className="ssh-browser-toolbar-button is-icon"
                        disabled={browserState.isLoading}
                        onClick={() => handleRefreshSshBrowser(browserState)}
                        title={browserState.isLoading ? 'Refreshing...' : 'Refresh'}
                        type="button"
                      >
                        <RefreshCw
                          aria-hidden="true"
                          className={`ssh-browser-toolbar-button-icon${
                            browserState.isLoading ? ' is-spinning' : ''
                          }`}
                        />
                      </button>
                    </div>
                    <div className="ssh-browser-toolbar-filters">
                      <label className="ssh-browser-filter-shell">
                        <Search aria-hidden="true" className="ssh-browser-filter-icon" />
                        <input
                          className="ssh-browser-filter-input"
                          onChange={(event) =>
                            handleChangeSshBrowserFilterQuery(
                              browserState.tabId,
                              event.target.value
                            )
                          }
                          placeholder="Filter by name"
                          type="text"
                          value={browserState.filterQuery}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="ssh-browser-section">
                    {browserSectionNote ? (
                      <p className="ssh-browser-section-note">{browserSectionNote}</p>
                    ) : null}
                    {browserState.errorMessage ? (
                      <p className="ssh-browser-error">{browserState.errorMessage}</p>
                    ) : null}
                    <div
                      className={`ssh-browser-list-shell${browserState.isLoading ? ' is-loading' : ''}`}
                    >
                      <div
                        className="ssh-browser-list-header"
                        title={browserDisplayPath ?? 'Remote path unavailable'}
                      >
                        <p className="ssh-browser-path">
                          {browserDisplayPath ?? 'Remote path unavailable'}
                        </p>
                      </div>
                      <div
                        className="ssh-browser-list"
                        ref={(node) => {
                          if (!node) {
                            sshBrowserListElementsRef.current.delete(tab.id)
                            return
                          }

                          sshBrowserListElementsRef.current.set(tab.id, node)
                        }}
                      >
                        {!browserState.errorMessage && visibleEntries.length === 0 ? (
                          <div className="ssh-browser-empty">
                            {browserState.isLoading
                              ? 'Loading remote files...'
                              : browserFilterQuery !== ''
                                ? `No matches for "${browserFilterQuery}".`
                                : 'This folder is empty.'}
                          </div>
                        ) : null}
                        {visibleEntries.map((entry) => {
                          const fileIconDescriptor = getSshBrowserFileIconDescriptor(entry.name)
                          const EntryIcon = entry.isDirectory ? Folder : fileIconDescriptor.icon
                          const canOpenInEditor = canEditSshRemoteFile(entry)
                          const entryMeta = [
                            entry.permissions,
                            entry.type === 'symlink' ? 'Link' : null
                          ]
                            .filter((value): value is string => Boolean(value))
                            .join(' • ')
                          const entrySummary = entry.isDirectory
                            ? 'Folder'
                            : entry.type === 'symlink'
                              ? 'Link'
                              : entry.type === 'other'
                                ? 'Special'
                                : formatSshBrowserEntrySize(entry.size)

                          return (
                            <button
                              className={`ssh-browser-entry${entry.isDirectory ? ' is-directory' : ''}${
                                canOpenInEditor ? ' is-editable' : ''
                              }`}
                              disabled={browserState.isLoading}
                              key={`${entry.type}-${entry.name}`}
                              onClick={
                                entry.isDirectory
                                  ? () => handleOpenSshBrowserDirectory(browserState, entry)
                                  : undefined
                              }
                              onContextMenu={(event) =>
                                handleOpenSshBrowserContextMenu(event, browserState, entry)
                              }
                              onDoubleClick={
                                entry.isDirectory
                                  ? undefined
                                  : () => handleOpenSshRemoteFile(browserState, entry)
                              }
                              onKeyDown={
                                entry.isDirectory
                                  ? undefined
                                  : (event) =>
                                      handleSshBrowserFileEntryKeyDown(event, browserState, entry)
                              }
                              title={
                                canOpenInEditor
                                  ? 'Press Enter or double-click to open in the editor'
                                  : undefined
                              }
                              type="button"
                            >
                              <span className="ssh-browser-entry-main">
                                <EntryIcon
                                  aria-hidden="true"
                                  className={`ssh-browser-entry-icon ${
                                    entry.isDirectory
                                      ? 'ssh-browser-entry-icon-directory'
                                      : fileIconDescriptor.toneClassName
                                  }`}
                                />
                                <span className="ssh-browser-entry-copy">
                                  <span className="ssh-browser-entry-name">{entry.name}</span>
                                  <span className="ssh-browser-entry-meta">
                                    {entryMeta || getSshBrowserEntryKindLabel(entry)}
                                  </span>
                                </span>
                              </span>
                              <span className="ssh-browser-entry-aside">
                                <span className="ssh-browser-entry-summary">{entrySummary}</span>
                                <span className="ssh-browser-entry-timestamp">
                                  {formatSshBrowserEntryTimestamp(entry.modifiedAt)}
                                </span>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
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
                  {canEditSshRemoteFile(sshBrowserContextMenu.entry) ? (
                    <button
                      className="ssh-browser-context-menu-item"
                      onClick={() =>
                        handleOpenSshRemoteFile(browserState, sshBrowserContextMenu.entry)
                      }
                      role="menuitem"
                      type="button"
                    >
                      <FileText aria-hidden="true" className="ssh-browser-context-menu-icon" />
                      Open in editor
                    </button>
                  ) : null}
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
      {isQuickOpenOpen ? (
        <Modal
          className="quick-open-dialog"
          contentLabel="Quick open"
          isOpen
          onRequestClose={() => closeQuickOpen()}
          overlayClassName="quick-open-shell"
        >
          <div className="quick-open-search">
            <Search aria-hidden="true" className="quick-open-search-icon" />
            <input
              aria-label="Search commands"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="quick-open-input"
              onChange={(event) => setQuickOpenQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeQuickOpen()
                  return
                }

                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setQuickOpenSelectedIndex((currentIndex) =>
                    filteredQuickOpenCommands.length === 0
                      ? 0
                      : (currentIndex + 1) % filteredQuickOpenCommands.length
                  )
                  return
                }

                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setQuickOpenSelectedIndex((currentIndex) =>
                    filteredQuickOpenCommands.length === 0
                      ? 0
                      : (currentIndex - 1 + filteredQuickOpenCommands.length) %
                        filteredQuickOpenCommands.length
                  )
                  return
                }

                if (event.key === 'Enter') {
                  event.preventDefault()
                  executeQuickOpenCommand(
                    filteredQuickOpenCommands[quickOpenSelectedIndex] ??
                      filteredQuickOpenCommands[0]
                  )
                }
              }}
              placeholder="Type a command"
              ref={quickOpenInputRef}
              spellCheck={false}
              type="text"
              value={quickOpenQuery}
            />
            <div aria-hidden="true" className="quick-open-trigger">
              <span className="quick-open-kbd">{primaryModifierLabel}</span>
              <span className="quick-open-kbd">P</span>
            </div>
          </div>
          <div
            aria-label="Available commands"
            className="quick-open-results"
            ref={quickOpenResultsRef}
            role="listbox"
          >
            {filteredQuickOpenCommands.length > 0 ? (
              filteredQuickOpenCommandGroups.map(({ group, items }) => (
                <div
                  aria-label={group.label}
                  className="quick-open-group"
                  key={group.id}
                  role="group"
                >
                  <div aria-hidden="true" className="quick-open-group-title">
                    {group.label}
                  </div>
                  {items.map(({ command, index }) => {
                    const Icon = command.icon
                    const isSelected = index === quickOpenSelectedIndex

                    return (
                      <button
                        aria-disabled={command.disabled}
                        aria-selected={isSelected}
                        className={`quick-open-item${isSelected ? ' is-selected' : ''}${command.disabled ? ' is-disabled' : ''}${command.group === 'quickCommands' ? ' is-quick-command' : ''}`}
                        key={command.id}
                        onClick={() => executeQuickOpenCommand(command)}
                        onMouseMove={() => {
                          if (quickOpenSelectedIndex !== index) {
                            setQuickOpenSelectedIndex(index)
                          }
                        }}
                        role="option"
                        type="button"
                      >
                        <span className="quick-open-item-icon-shell">
                          {command.sshServerIcon !== undefined ? (
                            <SshServerIconGlyph
                              className="quick-open-item-icon quick-open-item-icon-image"
                              icon={command.sshServerIcon}
                            />
                          ) : (
                            <Icon aria-hidden="true" className="quick-open-item-icon" />
                          )}
                        </span>
                        <span className="quick-open-item-copy">
                          <span className="quick-open-item-row">
                            <span className="quick-open-item-title">{command.title}</span>
                            {command.shortcut.length > 0 ? (
                              <span aria-hidden="true" className="quick-open-item-shortcut">
                                {command.shortcut.map((part) => (
                                  <span className="quick-open-kbd" key={`${command.id}-${part}`}>
                                    {part}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </span>
                          <span
                            className="quick-open-item-description"
                            title={
                              command.group === 'quickCommands' ? command.description : undefined
                            }
                          >
                            {command.description}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            ) : (
              <div className="quick-open-empty">No matching commands.</div>
            )}
          </div>
        </Modal>
      ) : null}
      {sshBrowserCreateDialogState && sshBrowserCreateDialogBrowserState ? (
        <SshBrowserCreateDialog
          browserState={sshBrowserCreateDialogBrowserState}
          draftState={sshBrowserCreateDialogState}
          onChangeName={handleChangeSshBrowserCreateDialogName}
          onClose={closeSshBrowserCreateDialog}
          onSubmit={handleSubmitSshBrowserCreateDialog}
        />
      ) : null}
      {sshRemoteEditorLoadingState ? (
        <SshRemoteEditorLoadingDialog loadingState={sshRemoteEditorLoadingState} />
      ) : null}
      {sshRemoteEditorState ? (
        <SshRemoteEditorDialog
          editorState={sshRemoteEditorState}
          onChangeContent={handleChangeSshRemoteEditorContent}
          onClose={() => {
            closeSshRemoteEditor()
          }}
          onReset={handleResetSshRemoteEditor}
          onSave={handleSaveSshRemoteEditor}
        />
      ) : null}
      {isSettingsDialogOpen ? (
        <SettingsDialog
          availableTerminalFontOptions={availableTerminalFontOptions}
          defaultNewTabDirectory={defaultNewTabDirectory}
          isSettingsTransferInProgress={isSettingsTransferInProgress}
          onClose={handleCloseSettingsDialog}
          onDefaultNewTabDirectoryChange={setDefaultNewTabDirectory}
          onExportSettings={handleExportSettings}
          onImportSettings={handleImportSettings}
          onQuickCommandsChange={setQuickCommands}
          onSftpBrowserOpenModeChange={setSelectedSftpBrowserOpenMode}
          onStartupModeChange={setSelectedStartupMode}
          onTerminalColorSchemeChange={setSelectedTerminalColorSchemeId}
          onTerminalCursorBlinkChange={setSelectedTerminalCursorBlink}
          onTerminalCursorColorChange={setSelectedTerminalCursorColor}
          onTerminalSelectionColorChange={setSelectedTerminalSelectionColor}
          onTerminalCursorStyleChange={setSelectedTerminalCursorStyle}
          onTerminalCursorWidthChange={setSelectedTerminalCursorWidth}
          onTerminalFontFamilyChange={setSelectedTerminalFontFamilyId}
          onTerminalFontSizeChange={setSelectedTerminalFontSize}
          onTerminalFontWeightChange={setSelectedTerminalFontWeight}
          onTerminalLineHeightChange={setSelectedTerminalLineHeight}
          quickCommands={quickCommands}
          settingsTransferAction={settingsTransferAction}
          settingsTransferMessage={settingsTransferMessage}
          settingsTransferTone={settingsTransferTone}
          selectedSftpBrowserOpenMode={selectedSftpBrowserOpenMode}
          selectedStartupMode={selectedStartupMode}
          selectedTerminalColorSchemeId={selectedTerminalColorSchemeId}
          selectedTerminalCursorBlink={selectedTerminalCursorBlink}
          selectedTerminalCursorColor={selectedTerminalCursorColor}
          selectedTerminalSelectionColor={selectedTerminalSelectionColor}
          selectedTerminalCursorStyle={selectedTerminalCursorStyle}
          selectedTerminalCursorWidth={selectedTerminalCursorWidth}
          selectedTerminalFontFamilyId={selectedTerminalFontFamilyId}
          selectedTerminalFontSize={selectedTerminalFontSize}
          selectedTerminalFontWeight={selectedTerminalFontWeight}
          selectedTerminalLineHeight={selectedTerminalLineHeight}
        />
      ) : null}
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
