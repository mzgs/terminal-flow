export interface LocalTextFile {
  content: string
  path: string
  size: number
}

export interface ShellPickPathsOptions {
  allowDirectories?: boolean
  allowFiles?: boolean
  buttonLabel?: string
  multiSelections?: boolean
  title?: string
}

export interface ShellApi {
  openExternal: (url: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  pickPaths: (options?: ShellPickPathsOptions) => Promise<string[]>
  readTextFile: (path: string) => Promise<LocalTextFile>
  writeTextFile: (path: string, content: string) => Promise<void>
}
