export interface AutomationRequest {
  action: 'activate' | 'new-terminal'
  command?: string
  cwd?: string
  id: string
  title?: string
}

export interface AutomationApi {
  drainRequests: () => Promise<AutomationRequest[]>
  onRequestsAvailable: (callback: () => void) => () => void
}
