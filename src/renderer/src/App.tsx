import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'ready' | 'closed'>('connecting')
  const terminalHostRef = useRef<HTMLDivElement>(null)
  const currentTerminalIdRef = useRef<number | null>(null)
  const closedRef = useRef(false)
  const platformClassName =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? 'platform-macos' : 'platform-default'

  useEffect(() => {
    const hostElement = terminalHostRef.current

    if (!hostElement) {
      return
    }

    let isMounted = true
    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
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
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(hostElement)
    terminal.write('Launching shell...\r\n')
    terminal.focus()

    const disposeData = window.api.terminal.onData((event) => {
      if (event.terminalId !== currentTerminalIdRef.current) {
        return
      }

      setStatus('ready')
      terminal.write(event.data)
    })

    const disposeExit = window.api.terminal.onExit((event) => {
      if (event.terminalId !== currentTerminalIdRef.current) {
        return
      }

      closedRef.current = true
      setStatus('closed')
      terminal.options.disableStdin = true
      terminal.write(`\r\n[process exited with code ${event.exitCode}]\r\n`)
    })

    const syncSize = (): void => {
      fitAddon.fit()

      if (currentTerminalIdRef.current !== null) {
        window.api.terminal.resize(currentTerminalIdRef.current, terminal.cols, terminal.rows)
      }
    }

    const resizeObserver = new ResizeObserver(() => syncSize())
    resizeObserver.observe(hostElement)

    const disposeInput = terminal.onData((data) => {
      if (currentTerminalIdRef.current === null || closedRef.current) {
        return
      }

      window.api.terminal.write(currentTerminalIdRef.current, data)
    })

    const focusTerminal = (): void => {
      terminal.focus()
    }

    hostElement.addEventListener('click', focusTerminal)

    window.api.terminal.create().then(({ terminalId: createdTerminalId }) => {
      if (!isMounted) {
        window.api.terminal.kill(createdTerminalId)
        return
      }

      closedRef.current = false
      currentTerminalIdRef.current = createdTerminalId
      setStatus('ready')
      syncSize()
      terminal.focus()
    }).catch((error) => {
      closedRef.current = true
      setStatus('closed')
      terminal.options.disableStdin = true
      terminal.write(`Unable to start shell: ${error instanceof Error ? error.message : String(error)}\r\n`)
    })

    return () => {
      const terminalId = currentTerminalIdRef.current

      isMounted = false
      disposeInput.dispose()
      disposeData()
      disposeExit()
      resizeObserver.disconnect()
      hostElement.removeEventListener('click', focusTerminal)

      if (terminalId !== null) {
        window.api.terminal.kill(terminalId)
        currentTerminalIdRef.current = null
      }

      terminal.dispose()
    }
  }, [])

  return (
    <main className={`app-shell ${platformClassName} status-${status}`}>
      <header className="window-titlebar">
        <span className="window-title">Terminal</span>
      </header>
      <div className="terminal-screen" ref={terminalHostRef} />
    </main>
  )
}

export default App
