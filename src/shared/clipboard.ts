export interface ClipboardApi {
  readText: () => string
  writeText: (text: string) => void
}
