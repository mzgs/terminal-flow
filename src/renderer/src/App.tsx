import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { HardDrive, Plus, Server, X } from 'lucide-react'
import { Reorder, useDragControls } from 'motion/react'
import '@xterm/xterm/css/xterm.css'

type TabStatus = 'connecting' | 'ready' | 'closed'

interface TabRecord {
  id: string
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

const defaultTabTitle = '~'

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
  theme: {
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
    white: '#f5f5f5',
    yellow: '#e6c15a'
  }
} satisfies ConstructorParameters<typeof Terminal>[0]

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

function quotePathForShell(path: string): string {
  if (usesWindowsShellQuoting()) {
    return /[\s&()[\]{}^=;!'+,`~]/.test(path) ? `"${path}"` : path
  }

  return path.replace(/([^A-Za-z0-9_./-])/g, '\\$1')
}

function getTabStatusLabel(tab: TabRecord): string {
  if (tab.status === 'connecting') {
    return 'Starting'
  }

  if (tab.errorMessage) {
    return 'Failed'
  }

  if (tab.status === 'closed') {
    return `Exited${typeof tab.exitCode === 'number' ? ` (${tab.exitCode})` : ''}`
  }

  return ''
}

interface ReorderableTabProps {
  closeTab: (tabId: string) => void
  index: number
  isActive: boolean
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>
  tab: TabRecord
}

function ReorderableTab({
  closeTab,
  index,
  isActive,
  setActiveTabId,
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
        onClick={() => setActiveTabId(tab.id)}
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

function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<TabRecord[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isSshMenuOpen, setIsSshMenuOpen] = useState(false)
  const nextTabIdRef = useRef(1)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const sshMenuRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<TabRecord[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const hostElementsRef = useRef(new Map<string, HTMLDivElement>())
  const runtimesRef = useRef(new Map<string, TerminalRuntime>())
  const terminalToTabRef = useRef(new Map<number, string>())
  const pendingTitlesRef = useRef(new Map<number, string>())
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

      if (shouldKill && !runtime.closed) {
        window.api.terminal.kill(runtime.terminalId)
      }
    }

    runtime.terminal.dispose()
    runtimesRef.current.delete(tabId)
  }, [])

  const createTab = useCallback((): void => {
    const tabId = `tab-${nextTabIdRef.current++}`
    const shouldActivateImmediately =
      activeTabIdRef.current === null || tabsRef.current.length === 0

    setTabs((currentTabs) => [
      ...currentTabs,
      {
        id: tabId,
        status: 'connecting',
        terminalId: null,
        title: defaultTabTitle
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

      const remainingTabs = currentTabs.filter((tab) => tab.id !== tabId)

      disposeTabRuntime(tabId, true)
      hostElementsRef.current.delete(tabId)

      setTabs(remainingTabs)
      setActiveTabId((currentActiveTabId) => {
        if (currentActiveTabId !== tabId) {
          return currentActiveTabId
        }

        return remainingTabs[tabIndex]?.id ?? remainingTabs[tabIndex - 1]?.id ?? null
      })
    },
    [disposeTabRuntime]
  )

  const selectAdjacentTab = useCallback((direction: -1 | 1): void => {
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
    setActiveTabId(currentTabs[nextIndex]?.id ?? null)
  }, [])

  const initializeTab = useCallback(
    (tabId: string, hostElement: HTMLDivElement): void => {
      if (runtimesRef.current.has(tabId)) {
        return
      }

      const terminal = new Terminal(terminalOptions)
      const fitAddon = new FitAddon()

      terminal.loadAddon(fitAddon)
      terminal.open(hostElement)

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

      window.api.terminal
        .create()
        .then(({ terminalId, title }) => {
          const currentRuntime = runtimesRef.current.get(tabId)

          if (!currentRuntime || currentRuntime.disposed || isUnmountingRef.current) {
            window.api.terminal.kill(terminalId)
            return
          }

          currentRuntime.terminalId = terminalId
          terminalToTabRef.current.set(terminalId, tabId)

          updateTab(tabId, (tab) => ({
            ...tab,
            status: 'ready',
            terminalId,
            title: pendingTitlesRef.current.get(terminalId) ?? title
          }))
          pendingTitlesRef.current.delete(terminalId)

          if (pendingActivationTabIdRef.current === tabId) {
            pendingActivationTabIdRef.current = null
            setActiveTabId(tabId)
          }

          if (activeTabIdRef.current === tabId) {
            syncActiveTabLayout(tabId, true)
          }
        })
        .catch((error) => {
          const currentRuntime = runtimesRef.current.get(tabId)
          const message = error instanceof Error ? error.message : String(error)

          if (!currentRuntime || currentRuntime.disposed) {
            return
          }

          currentRuntime.closed = true
          currentRuntime.terminal.options.disableStdin = true
          currentRuntime.terminal.write(`Unable to start shell: ${message}\r\n`)

          updateTab(tabId, (tab) => ({
            ...tab,
            errorMessage: message,
            status: 'closed',
            terminalId: null
          }))

          if (pendingActivationTabIdRef.current === tabId) {
            pendingActivationTabIdRef.current = null
            setActiveTabId(tabId)
          }
        })
    },
    [syncActiveTabLayout, updateTab]
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
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  useEffect(() => {
    isUnmountingRef.current = false

    if (tabs.length === 0 && !isUnmountingRef.current && !emptyStateCreateQueuedRef.current) {
      emptyStateCreateQueuedRef.current = true
      createTab()
    }
  }, [createTab, tabs.length])

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

      runtime.terminal.write(event.data)
    })

    const disposeExit = window.api.terminal.onExit((event) => {
      const tabId = terminalToTabRef.current.get(event.terminalId)

      if (!tabId) {
        return
      }

      const runtime = runtimesRef.current.get(tabId)

      terminalToTabRef.current.delete(event.terminalId)
      pendingTitlesRef.current.delete(event.terminalId)

      if (!runtime || runtime.disposed) {
        return
      }

      runtime.closed = true
      runtime.terminalId = null
      runtime.terminal.options.disableStdin = true
      runtime.terminal.write(`\r\n[process exited with code ${event.exitCode}]\r\n`)

      updateTab(tabId, (tab) => ({
        ...tab,
        exitCode: event.exitCode,
        status: 'closed',
        terminalId: null
      }))
    })

    return () => {
      disposeData()
      disposeExit()
    }
  }, [updateTab])

  useEffect(() => {
    const disposeCwd = window.api.terminal.onCwd((event) => {
      const tabId = terminalToTabRef.current.get(event.terminalId)

      if (!tabId) {
        pendingTitlesRef.current.set(event.terminalId, event.title)
        return
      }

      updateTab(tabId, (tab) => {
        if (tab.title === event.title) {
          return tab
        }

        return {
          ...tab,
          title: event.title
        }
      })
    })

    return () => {
      disposeCwd()
    }
  }, [updateTab])

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
        setActiveTabId(targetTab.id)
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
  }, [closeTab, createTab, selectAdjacentTab])

  useEffect(() => {
    syncActiveTabLayout(activeTabId, true)
    syncTabStripPosition(activeTabId)
  }, [activeTabId, syncActiveTabLayout, syncTabStripPosition, tabs.length])

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

    return () => {
      isUnmountingRef.current = true

      for (const tabId of Array.from(runtimes.keys())) {
        disposeTabRuntime(tabId, true)
      }

      hostElements.clear()
    }
  }, [disposeTabRuntime])

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

      writeDroppedPathsToActiveTerminal(Array.from(droppedPaths))
    },
    [writeDroppedPathsToActiveTerminal]
  )

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
                  setActiveTabId={setActiveTabId}
                  tab={tab}
                />
              )
            })}
          </Reorder.Group>
          <div aria-hidden="true" className="tab-strip-fill" />
        </div>
        <div aria-hidden="true" className="window-drag-spacer" />
        <div className="tab-actions">
          <button
            aria-label="Create a new tab"
            className="tab-action"
            onClick={() => createTab()}
            title="New tab"
            type="button"
          >
            <Plus aria-hidden="true" className="tab-action-icon" />
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
                  onClick={() => setIsSshMenuOpen(false)}
                  role="menuitem"
                  type="button"
                >
                  <HardDrive aria-hidden="true" className="tab-action-menu-icon" />
                  Add SSH Server
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <section
        className="terminal-workspace"
        onDragOver={handleWorkspaceDragOver}
        onDrop={handleWorkspaceDrop}
        ref={workspaceRef}
      >
        {tabs.map((tab) => (
          <div
            aria-hidden={tab.id !== activeTabId}
            className={`terminal-screen${tab.id === activeTabId ? ' is-active' : ''}`}
            id={`panel-${tab.id}`}
            key={tab.id}
            ref={(node) => {
              if (!node) {
                hostElementsRef.current.delete(tab.id)
                return
              }

              hostElementsRef.current.set(tab.id, node)
              initializeTab(tab.id, node)
            }}
            role="tabpanel"
          />
        ))}
      </section>
    </main>
  )
}

export default App
