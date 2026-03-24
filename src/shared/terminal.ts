export interface TerminalCreateResult {
  terminalId: number
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

export interface TerminalApi {
  create: () => Promise<TerminalCreateResult>
  write: (terminalId: number, data: string) => void
  resize: (terminalId: number, cols: number, rows: number) => void
  kill: (terminalId: number) => void
  onData: (callback: (event: TerminalDataEvent) => void) => () => void
  onExit: (callback: (event: TerminalExitEvent) => void) => () => void
}
