export interface TerminalCreateOptions {
  args?: string[]
  command?: string
  cwd?: string
  env?: Record<string, string>
  title?: string
  trackCwd?: boolean
}

export interface TerminalCreateResult {
  terminalId: number
  title: string
}

export interface TerminalDataEvent {
  terminalId: number
  data: string
}

export interface TerminalExitEvent {
  terminalId: number
  exitCode: number
  signal?: number
}

export interface TerminalCwdEvent {
  terminalId: number
  cwd: string
  title: string
}

export interface TerminalNavigationShortcutEvent {
  data: string
}

export interface TerminalApi {
  create: (options?: TerminalCreateOptions) => Promise<TerminalCreateResult>
  write: (terminalId: number, data: string) => void
  resize: (terminalId: number, cols: number, rows: number) => void
  kill: (terminalId: number) => void
  setFocused: (focused: boolean) => void
  onFindRequested: (callback: () => void) => () => void
  onNavigationShortcut: (callback: (event: TerminalNavigationShortcutEvent) => void) => () => void
  onData: (callback: (event: TerminalDataEvent) => void) => () => void
  onCwd: (callback: (event: TerminalCwdEvent) => void) => () => void
  onExit: (callback: (event: TerminalExitEvent) => void) => () => void
}
