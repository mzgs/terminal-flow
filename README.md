# TerminalFlow

A small native terminal built with [GPUI Kit](https://github.com/longbridge/gpui-kit), [WezTerm's `wezterm-term`](https://github.com/wezterm/wezterm/tree/main/term) emulator, and its `portable-pty` library.

## macOS automation

Run `./scripts/install-macos-app.sh` to build and install `TerminalFlow.app` and
`TerminalFlow Finder.app` in Applications and register the `terminalflow://`
scheme. macOS routes links to the running app, or launches it when needed.

```sh
open 'terminalflow://activate'
open 'terminalflow://new-terminal?cwd=%2Ftmp&title=Build&command=pwd'
```

`activate` brings the window forward. `new-terminal` opens and focuses a local
tab. Its optional parameters are `cwd` (an existing absolute folder), `title`
(a tab label), and `command` (shell text submitted once, including multiline
commands). Omitted `cwd` uses the configured new-tab folder; empty parameters
use defaults. Percent-encode parameter values; encode a literal `+` as `%2B`.
Invalid links show an error without creating a tab. Titles last for the tab's
lifetime; session restore keeps the directory but does not restore the custom
title or rerun the command.

The Finder helper opens a new tab at the front Finder window's folder, or the
Desktop when no Finder window is open. Command-drag the helper app into Finder's
toolbar for quick access. Allow its Finder automation permission when macOS
prompts. It targets this Rust app by bundle identifier, even if another version
of TerminalFlow also handles the URL scheme.
